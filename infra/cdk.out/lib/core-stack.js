"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoreStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const secrets = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
class CoreStack extends aws_cdk_lib_1.Stack {
    mediaBucket;
    jobsTable;
    constructor(scope, id, props) {
        super(scope, id, props);
        // Use the AWS-managed KMS key for Secrets Manager
        const smManagedKey = kms.Alias.fromAliasName(this, 'SmManaged', 'alias/aws/secretsmanager');
        this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
            versioned: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN
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
exports.CoreStack = CoreStack;
