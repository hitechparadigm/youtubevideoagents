import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';

export class CoreStack extends Stack {
  readonly mediaBucket: s3.Bucket;
  readonly jobsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Use the AWS-managed KMS key for Secrets Manager
    const smManagedKey = kms.Alias.fromAliasName(this, 'SmManaged', 'alias/aws/secretsmanager');

    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN
    });

    this.jobsTable = new dynamodb.Table(this, 'Jobs', {
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl'
    });

    // Secrets (now explicitly encrypted with the AWS-managed key)
    new secrets.Secret(this, 'YouTubeOAuth', {
      secretName: 'youtube/oauth',
      encryptionKey: smManagedKey
    });
    new secrets.Secret(this, 'PexelsKey', {
      secretName: 'pexels/apiKey',
      encryptionKey: smManagedKey
    });
    new secrets.Secret(this, 'ElevenLabsKey', {
      secretName: 'elevenlabs/apiKey',
      encryptionKey: smManagedKey
    });
  }
}
