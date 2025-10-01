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
exports.WorkflowStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const sfn = __importStar(require("aws-cdk-lib/aws-stepfunctions"));
const tasks = __importStar(require("aws-cdk-lib/aws-stepfunctions-tasks"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
class WorkflowStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const region = aws_cdk_lib_1.Stack.of(this).region;
        const account = aws_cdk_lib_1.Stack.of(this).account;
        const common = {
            runtime: lambda.Runtime.PYTHON_3_12,
            timeout: aws_cdk_lib_1.Duration.seconds(60),
            memorySize: 512,
            handler: 'app.handler',
            environment: {
                MEDIA_BUCKET: props.mediaBucket.bucketName,
                JOBS_TABLE: props.jobsTable.tableName,
            },
        };
        // Lambdas
        const scriptFn = new lambda.Function(this, 'ScriptFn', {
            ...common, functionName: 'scriptFn',
            code: lambda.Code.fromAsset('../services'),
        });
        const ttsFn = new lambda.Function(this, 'TtsFn', {
            ...common, functionName: 'ttsFn',
            code: lambda.Code.fromAsset('../services'),
        });
        const brollFn = new lambda.Function(this, 'BrollFn', {
            ...common, functionName: 'brollFn',
            code: lambda.Code.fromAsset('../services'),
        });
        const uploadFn = new lambda.Function(this, 'UploadFn', {
            ...common, functionName: 'uploadFn',
            timeout: aws_cdk_lib_1.Duration.seconds(120),
            code: lambda.Code.fromAsset('../services'),
        });
        // Data access
        props.mediaBucket.grantReadWrite(scriptFn);
        props.mediaBucket.grantReadWrite(ttsFn);
        props.mediaBucket.grantReadWrite(brollFn);
        props.mediaBucket.grantReadWrite(uploadFn);
        props.jobsTable.grantReadWriteData(scriptFn);
        props.jobsTable.grantReadWriteData(ttsFn);
        props.jobsTable.grantReadWriteData(uploadFn);
        // Bedrock & Polly
        scriptFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [`arn:aws:bedrock:${region}::foundation-model/*`],
            effect: iam.Effect.ALLOW,
        }));
        ttsFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['polly:SynthesizeSpeech'],
            resources: ['*'],
            effect: iam.Effect.ALLOW,
        }));
        // Secrets (Pexels/ElevenLabs/YouTube)
        const secretArns = [
            `arn:aws:secretsmanager:${region}:${account}:secret:pexels/apiKey-*`,
            `arn:aws:secretsmanager:${region}:${account}:secret:elevenlabs/apiKey-*`,
            `arn:aws:secretsmanager:${region}:${account}:secret:youtube/oauth-*`,
        ];
        [brollFn, ttsFn, uploadFn].forEach(fn => {
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: secretArns,
                effect: iam.Effect.ALLOW,
            }));
        });
        // Networking for Fargate
        const vpc = props.cluster.vpc;
        const rendererSG = new ec2.SecurityGroup(this, 'RendererTaskSg', {
            vpc,
            description: 'ECS Fargate task for renderer (egress only)',
            allowAllOutbound: true,
        });
        // ECS render task
        props.mediaBucket.grantReadWrite(props.rendererTask.taskRole);
        const renderTask = new tasks.EcsRunTask(this, 'RenderECS', {
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            cluster: props.cluster,
            taskDefinition: props.rendererTask,
            assignPublicIp: true,
            launchTarget: new tasks.EcsFargateLaunchTarget(),
            subnets: { subnetType: ec2.SubnetType.PUBLIC },
            securityGroups: [rendererSG],
            containerOverrides: [{
                    containerDefinition: props.rendererTask.defaultContainer,
                    environment: [
                        { name: 'JOB_ID', value: sfn.JsonPath.stringAt('$.jobId') },
                        { name: 'MEDIA_BUCKET', value: props.mediaBucket.bucketName },
                        { name: 'AWS_REGION', value: region },
                    ],
                }],
            resultPath: '$.render',
            // >>> extend the Step Functions state timeout for this task <<<
            taskTimeout: sfn.Timeout.duration(aws_cdk_lib_1.Duration.minutes(15)),
        });
        // Steps
        const scriptStep = new tasks.LambdaInvoke(this, 'Script', { lambdaFunction: scriptFn, resultPath: '$.script' });
        const ttsStep = new tasks.LambdaInvoke(this, 'TTS', { lambdaFunction: ttsFn, resultPath: '$.tts' });
        const brollStep = new tasks.LambdaInvoke(this, 'Broll', { lambdaFunction: brollFn, resultPath: '$.broll' });
        const uploadStep = new tasks.LambdaInvoke(this, 'Upload', { lambdaFunction: uploadFn, resultPath: '$.upload' });
        const definition = sfn.Chain
            .start(scriptStep)
            .next(ttsStep)
            .next(brollStep)
            .next(renderTask)
            .next(uploadStep);
        // Logs for the state machine
        const smLogs = new logs.LogGroup(this, 'PipelineLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
        });
        const sm = new sfn.StateMachine(this, 'Pipeline', {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: aws_cdk_lib_1.Duration.minutes(20),
            logs: {
                destination: smLogs,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });
        // Allow SFN to run ECS and manage EventBridge callback
        const taskDefArn = props.rendererTask.taskDefinitionArn;
        const taskRoleArn = props.rendererTask.taskRole.roleArn;
        const execRoleArn = props.rendererTask.obtainExecutionRole().roleArn;
        sm.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks'],
            resources: ['*'], // keep broad to avoid family/version drift issues
        }));
        sm.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: [taskRoleArn, execRoleArn],
        }));
        sm.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'events:PutRule', 'events:PutTargets', 'events:DescribeRule',
                'events:DeleteRule', 'events:RemoveTargets'
            ],
            resources: ['*'],
        }));
        new aws_cdk_lib_1.CfnOutput(this, 'PipelineArn', { value: sm.stateMachineArn });
    }
}
exports.WorkflowStack = WorkflowStack;
