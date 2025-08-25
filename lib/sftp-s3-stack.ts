import * as cdk from 'aws-cdk-lib';
import { SpotInstance } from "cdk-ec2-spot-simple";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import path from 'path';

interface SftpS3StackProps extends cdk.StackProps {
  environment?: string;
  tailscaleAuthKey?: string;
}

export class SftpS3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: SftpS3StackProps) {
    super(scope, id, props);

    // Look up the default VPC
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });

    // Create a security group for the SFTP server
    const securityGroup = new ec2.SecurityGroup(this, 'SftpSecurityGroup', {
      vpc: vpc,
      description: 'Allow SFTP access',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SFTP access from anywhere');

    // User data script to set up the SFTP server
    const sftpUserData = ec2.UserData.forLinux();
    sftpUserData.addCommands(
      'set -eu',
      'yum update -y',
      'yum install -y amazon-ssm-agent',
      'systemctl enable amazon-ssm-agent',
      'systemctl start amazon-ssm-agent',
      'yum install -y vsftpd',
      'systemctl start vsftpd',
      'systemctl enable vsftpd',
      'adduser sftpuser',
      'echo "sftpuserr ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers',
      'mkdir -p /home/sftpuser/upload',
      'chown sftpuser:sftpuser /home/sftpuser',
      'chmod 755 /home/sftpuser',
      'chown sftpuser:sftpuser /home/sftpuser/upload',
      'echo "sftpuser:eXmbtL&YWmFqwt2q" | chpasswd',
      'sed -i "s/.*Subsystem sftp.*/Subsystem sftp internal-sftp/" /etc/ssh/sshd_config',
      'sed -i "/^Match User sftpuser$/,/^$/ s/.*ChrootDirectory.*/ChrootDirectory \\/home\\/sftpuser/" /etc/ssh/sshd_config',
      'sed -i "/^Match User sftpuser$/,/^$/ s/.*ForceCommand.*/ForceCommand internal-sftp/" /etc/ssh/sshd_config',
      'systemctl restart sshd',
    );

    if (props?.tailscaleAuthKey) {
      sftpUserData.addCommands(
      'set -eu',
      'curl https://tailscale.com/install.sh >install.sh',
      'chmod +x ./install.sh',
      './install.sh',
      'tailscale up --hostname=sftp-server-' + (props?.environment ?? 'dev') + ' --authkey=' + props?.tailscaleAuthKey + '',
      'tailscale set --ssh',
      );
    }

    // Create an EC2 instance for SFTP server
    const sftpServer = new SpotInstance(this, 'sftpServer', {
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpc: vpc,
      securityGroup: securityGroup,
      userData: sftpUserData,
    });

    // Create S3 Bucket
    const s3Bucket = new s3.Bucket(this, 'SftpFilesBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
    });

    // Create Secret for SFTP credentials
    const sftpSecret = new secretsmanager.Secret(this, 'SftpSecret', {
      secretName: 'sftp-server-credentials',
      description: 'SFTP server connection details',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          SFTP_HOST: sftpServer.instancePublicIp,
          SFTP_USER: 'sftpuser',
          SFTP_DIR: '/upload',
        }),
        generateStringKey: 'SFTP_PASSPHRASE',
        excludePunctuation: true,
        passwordLength: 16,
      },
    });

    // Add this to your stack
    const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
      code: lambda.Code.fromAsset('lambda/layer'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      description: 'Layer containing SFTP and unzipper dependencies',
    });

    // Create Lambda Function
    const sftpToS3Lambda = new NodejsFunction(this, 'SftpToS3Lambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: 'lambda/sftp-to-s3-handler.ts',
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      layers: [dependenciesLayer],
      environment: {
        SFTP_SECRET_NAME: sftpSecret.secretName,
        S3_BUCKET: s3Bucket.bucketName,
      },
      depsLockFilePath: path.join(__dirname, '..', 'bun.lock'),
      bundling: {
        externalModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/client-secrets-manager',
          'ssh2-sftp-client',
          'unzipper',
          'ssh2', // ssh2-sftp-client dependency
          // '@stargate/splunk-logger',
        ],
      },
    });

    // Grant permissions to Lambda
    s3Bucket.grantReadWrite(sftpToS3Lambda);
    sftpSecret.grantRead(sftpToS3Lambda);

    sftpToS3Lambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [sftpSecret.secretArn],
    }));

    // Create EventBridge rule to trigger Lambda every 15 minutes
    const rule = new events.Rule(this, 'ScheduledRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    rule.addTarget(new targets.LambdaFunction(sftpToS3Lambda));

  }
}