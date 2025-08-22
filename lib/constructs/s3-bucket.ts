import { Construct } from 'constructs';
import {
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  StorageClass
} from 'aws-cdk-lib/aws-s3';
import {
  Duration,
  RemovalPolicy
} from 'aws-cdk-lib';

export interface S3BucketConstructProps {
  bucketName?: string;
}

export class S3BucketConstruct extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: S3BucketConstructProps) {
    super(scope, id);

    this.bucket = new Bucket(this, 'Bucket', {
      bucketName: props.bucketName,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true
      },
      lifecycleRules: [
        {
          id: 'incomplete-mpu-cleanup',
          abortIncompleteMultipartUploadAfter: Duration.days(7)
        },
        {
          id: 'transition-to-ia',
          transitions: [
            {
              storageClass: StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30)
            }
          ]
        }
      ],
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });
  }
}
