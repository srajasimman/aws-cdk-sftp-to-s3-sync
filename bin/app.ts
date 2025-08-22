#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { SftpIngestStack } from '../lib/sftp-ingest-stack.js';

const app = new App();

const environment = app.node.tryGetContext('environment') || 'dev';
const envConfig = app.node.tryGetContext('environments')[environment];

new SftpIngestStack(app, `SftpIngestStack-${environment}`, {
  env: {
    account: envConfig.account,
    region: envConfig.region
  },
  vpcCidr: process.env.VPC_CIDR || '10.0.0.0/16',
  bucketName: process.env.BUCKET_NAME,
  remoteDir: process.env.REMOTE_DIR || '/data/inbound',
  scheduleRateMinutes: 15,
  enableDdbIdempotency: true
});
