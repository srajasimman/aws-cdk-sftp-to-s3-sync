import { Construct } from 'constructs';
import {
  IpAddresses,
  Vpc,
  SubnetType,
  InterfaceVpcEndpointAwsService,
  GatewayVpcEndpointAwsService
} from 'aws-cdk-lib/aws-ec2';

export interface VpcConstructProps {
  cidr: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: Vpc;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr(props.cidr),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        }
      ],
      gatewayEndpoints: {
        S3: {
          service: GatewayVpcEndpointAwsService.S3
        }
      }
    });

    // Add interface endpoints for Secrets Manager and CloudWatch Logs
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER
    });

    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
    });
  }
}
