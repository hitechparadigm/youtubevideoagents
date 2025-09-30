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
exports.ComputeStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
class ComputeStack extends aws_cdk_lib_1.Stack {
    cluster;
    rendererTask;
    constructor(scope, id, props) {
        super(scope, id, props);
        const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });
        this.cluster = new ecs.Cluster(this, 'Cluster', { vpc });
        const repo = new ecr.Repository(this, 'RendererRepo', {});
        this.rendererTask = new ecs.FargateTaskDefinition(this, 'RendererTask', {
            cpu: 2048,
            memoryLimitMiB: 4096,
            ephemeralStorageGiB: 50
        });
        const logGroup = new logs.LogGroup(this, 'RendererLogs');
        const container = this.rendererTask.addContainer('Renderer', {
            image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
            environment: { MEDIA_BUCKET: props.mediaBucket.bucketName },
            logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'renderer' })
        });
        container.addUlimits({ name: ecs.UlimitName.NOFILE, hardLimit: 1048576, softLimit: 1048576 });
        props.mediaBucket.grantReadWrite(this.rendererTask.taskRole);
        new aws_cdk_lib_1.CfnOutput(this, 'RendererRepoUri', { value: repo.repositoryUri });
    }
}
exports.ComputeStack = ComputeStack;
