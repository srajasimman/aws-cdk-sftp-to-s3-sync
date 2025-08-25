#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SftpS3Stack } from '../lib/sftp-s3-stack';
import 'dotenv/config';

const app = new cdk.App();

const tailscaleAuthKey = app.node.tryGetContext('tailscaleAuthKey') || process.env.TAILSCALE_AUTH_KEY;
const environment = app.node.tryGetContext('environment') || 'dev';
const envConfig = app.node.tryGetContext('environments')[environment];
const prNumber = app.node.tryGetContext('prNumber');

if (!envConfig) {
  throw new Error(`Environment configuration for '${environment}' not found in cdk.json`);
}

const stackName = () => {
  let name = app.node.tryGetContext('stack-name') || 'sftp-to-s3';
  if (prNumber) {
    name = `${name}-${environment}-pr${prNumber}`;
  }
  name = `${name}-${environment}`;
  return name;
};

new SftpS3Stack(app, 'SftpS3Stack', {
  stackName: stackName(),
  env: {
    account: envConfig.account || process.env.CDK_DEFAULT_ACCOUNT,
    region: envConfig.region || process.env.CDK_DEFAULT_REGION,
  },
  environment: environment,
  tailscaleAuthKey: tailscaleAuthKey,
});