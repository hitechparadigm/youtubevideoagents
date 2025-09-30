import { Stack, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
export class CoreStack extends Stack {
    mediaBucket;
    jobsTable;
    constructor(scope, id, props) {
        super(scope, id, props);
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
        // Secret placeholders (you'll set values later)
        new secrets.Secret(this, 'YouTubeOAuth', { secretName: 'youtube/oauth' });
        new secrets.Secret(this, 'PexelsKey', { secretName: 'pexels/apiKey' });
        new secrets.Secret(this, 'ElevenLabsKey', { secretName: 'elevenlabs/apiKey' });
    }
}
