# SFTP to S3 Ingest

This project implements an automated SFTP to Amazon S3 file ingestion solution using AWS CDK. It sets up a secure infrastructure for transferring files from an SFTP server to an S3 bucket with support for idempotency and error handling.

## Architecture

![Architecture Diagram](./architecture-diagram.png)

The solution includes the following components:

- **VPC** with public and private subnets
- **EC2 Instance** running as an SFTP server
- **S3 Bucket** for storing ingested files
- **Lambda Function** for file ingestion
- **EventBridge Rule** for scheduled execution
- **DynamoDB Table** for idempotency tracking (optional)
- **Secrets Manager** for SFTP credentials
- **Dead Letter Queue** for error handling

## Prerequisites

- Node.js 20.x or later
- AWS CDK v2
- Bun package manager
- AWS CLI configured with appropriate credentials
- TypeScript knowledge

## Installation

1. Clone the repository:

```bash
git clone [repository-url]
cd sftp-to-s3
```

2. Install dependencies:

```bash
bun install
```

3. Build the project:

```bash
bun run build
```

## Configuration

The stack can be configured using the following properties:

| Property               | Description                          | Default         |
| ---------------------- | ------------------------------------ | --------------- |
| `vpcCidr`              | CIDR range for the VPC               | '10.0.0.0/16'   |
| `instanceType`         | EC2 instance type                    | t3.small        |
| `bucketName`           | Name of the S3 bucket                | Auto-generated  |
| `remoteDir`            | SFTP remote directory to monitor     | '/data/inbound' |
| `scheduleRateMinutes`  | Frequency of ingestion in minutes    | 15              |
| `enableDdbIdempotency` | Enable DynamoDB idempotency tracking | true            |

## Deployment

1. Bootstrap your AWS environment (if not already done):

```bash
cdk bootstrap
```

2. Deploy the stack:

```bash
cdk deploy
```

3. After deployment, note the following outputs:

- SFTP server public IP
- S3 bucket name
- Secrets Manager ARN
- Lambda function name
- DynamoDB table name (if enabled)

## Security

The solution implements several security best practices:

- SFTP server in a public subnet with restricted security group
- Lambda function in a private subnet
- S3 bucket with encryption and versioning
- Secrets Manager for credential management
- IAM roles with least privilege
- VPC endpoints for AWS services

## Post-Deployment Setup

1. Update the SFTP credentials in Secrets Manager with:

   - Host (EC2 instance public IP)
   - Username
   - Private key or password
   - Known hosts entry

2. Configure the SFTP server:
   - Set up the required user
   - Configure the directory structure
   - Set appropriate permissions

## Monitoring and Logs

- Lambda function logs in CloudWatch Logs
- Failed executions tracked in SQS Dead Letter Queue
- EC2 instance logs available through Systems Manager
- S3 bucket access logs (if enabled)

## Development

1. Make code changes
2. Run build:

```bash
bun run build
```

3. Run tests (if available):

```bash
bun test
```

4. Deploy changes:

```bash
cdk deploy
```

## Clean Up

To avoid incurring charges, destroy the stack when no longer needed:

```bash
cdk destroy
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

[Add your license here]

---

Built with ❤️ using AWS CDK and TypeScript
