import { Construct } from 'constructs';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { VpcConstruct } from './constructs/vpc.js';
import { S3BucketConstruct } from './constructs/s3-bucket.js';

export interface SftpIngestStackProps extends StackProps {
  vpcCidr?: string;
  instanceType?: string;
  keyPairName?: string;
  bucketName?: string;
  remoteDir?: string;
  scheduleRateMinutes?: number;
  enableDdbIdempotency?: boolean;
}

export class SftpIngestStack extends Stack {
  constructor(scope: Construct, id: string, props?: SftpIngestStackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new VpcConstruct(this, 'VpcConstruct', {
      cidr: props?.vpcCidr ?? '10.0.0.0/16'
    });

    // S3 Bucket
    const s3 = new S3BucketConstruct(this, 'S3BucketConstruct', {
      bucketName: props?.bucketName
    });

    // DynamoDB Table (if idempotency enabled)
    let ddbTable;
      if (props?.enableDdbIdempotency !== false) {
      ddbTable = new dynamodb.Table(this, 'ProcessedFilesTable', {
        partitionKey: { name: 'path', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'mtime', type: dynamodb.AttributeType.NUMBER },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'expiresAt',
        removalPolicy: RemovalPolicy.DESTROY
      });
    }    // Dead Letter Queue
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: Duration.days(14)
    });

    // SFTP Server Security Group
    const sftpServerSg = new ec2.SecurityGroup(this, 'SftpServerSecurityGroup', {
      vpc: vpc.vpc,
      description: 'Security group for SFTP server',
      allowAllOutbound: false
    });

    sftpServerSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow inbound SSH from anywhere'
    );

    // Lambda Security Group
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: vpc.vpc,
      description: 'Security group for Lambda function',
      allowAllOutbound: false
    });

    // Allow Lambda to connect to SFTP server
    lambdaSg.addEgressRule(
      sftpServerSg,
      ec2.Port.tcp(22),
      'Allow outbound SSH to SFTP server'
    );

    // SFTP Credentials Secret
    const sftpSecret = new secretsmanager.Secret(this, 'SftpCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          host: '',
          port: 22,
          username: 'ingestuser',
          auth: {
            type: 'privateKey',
            privateKey: '',
            passphrase: ''
          },
          fallbackPassword: '',
          knownHosts: ''
        }),
        generateStringKey: 'dummy'
      }
    });

    // EC2 Role
    const ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // EC2 Instance
    const ec2Instance = new ec2.Instance(this, 'SftpServer', {
      vpc: vpc.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'),
      securityGroup: sftpServerSg,
      role: ec2Role
    });

    // Lambda Role
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      ]
    });

    // Add permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [sftpSecret.secretArn]
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:PutObject',
          's3:AbortMultipartUpload',
          's3:ListBucket'
        ],
        resources: [
          s3.bucket.bucketArn,
          `${s3.bucket.bucketArn}/*`
        ]
      })
    );

    if (ddbTable) {
      lambdaRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:PutItem',
            'dynamodb:GetItem',
            'dynamodb:Query'
          ],
          resources: [ddbTable.tableArn]
        })
      );
    }

    // Lambda Function
    const ingestFunction = new lambda.Function(this, 'IngestFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src'),
      environment: {
        SECRET_NAME: sftpSecret.secretName,
        TARGET_BUCKET: s3.bucket.bucketName,
        TARGET_PREFIX: 'ingest/',
        REMOTE_DIR: props?.remoteDir ?? '/data/inbound',
        LOOKBACK_MINUTES: props?.scheduleRateMinutes?.toString() ?? '15',
        REGION: Stack.of(this).region,
        DDB_TABLE: ddbTable?.tableName ?? ''
      },
      vpc: vpc.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroups: [lambdaSg],
      role: lambdaRole,
      timeout: Duration.minutes(5),
      memorySize: 512,
      deadLetterQueueEnabled: true,
      deadLetterQueue: dlq,
      logGroup: new logs.LogGroup(this, 'IngestFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY
      })
    });

    // EventBridge Rule
    new events.Rule(this, 'ScheduleRule', {
      schedule: events.Schedule.rate(Duration.minutes(props?.scheduleRateMinutes ?? 15)),
      targets: [new targets.LambdaFunction(ingestFunction)],
      description: 'Trigger SFTP to S3 ingest Lambda function'
    });

    // Outputs
    new CfnOutput(this, 'BucketName', {
      value: s3.bucket.bucketName,
      description: 'Name of the S3 bucket'
    });

    new CfnOutput(this, 'Ec2PublicIp', {
      value: ec2Instance.instancePublicIp,
      description: 'Public IP of the SFTP server'
    });

    new CfnOutput(this, 'SecretArn', {
      value: sftpSecret.secretArn,
      description: 'ARN of the Secrets Manager secret'
    });

    new CfnOutput(this, 'LambdaName', {
      value: ingestFunction.functionName,
      description: 'Name of the Lambda function'
    });

    if (ddbTable) {
      new CfnOutput(this, 'DynamoDBTableName', {
        value: ddbTable.tableName,
        description: 'Name of the DynamoDB table'
      });
    }
  }
}
