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
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
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
            ...common,
            functionName: 'scriptFn',
            code: lambda.Code.fromAsset('../services'),
        });
        const ttsFn = new lambda.Function(this, 'TtsFn', {
            ...common,
            functionName: 'ttsFn',
            code: lambda.Code.fromAsset('../services'),
        });
        const brollFn = new lambda.Function(this, 'BrollFn', {
            ...common,
            functionName: 'brollFn',
            code: lambda.Code.fromAsset('../services'),
        });
        const uploadFn = new lambda.Function(this, 'UploadFn', {
            ...common,
            functionName: 'uploadFn',
            timeout: aws_cdk_lib_1.Duration.seconds(120),
            code: lambda.Code.fromAsset('../services'),
        });
        // S3 / Dynamo permissions
        props.mediaBucket.grantReadWrite(scriptFn);
        props.mediaBucket.grantReadWrite(ttsFn);
        props.mediaBucket.grantReadWrite(brollFn);
        props.mediaBucket.grantReadWrite(uploadFn);
        props.jobsTable.grantReadWriteData(scriptFn);
        props.jobsTable.grantReadWriteData(uploadFn);
        // --- Bedrock permission for the script generator ---
        scriptFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [`arn:aws:bedrock:${region}::foundation-model/*`],
        }));
        // --- Secrets Manager read for API keys (Pexels / ElevenLabs / YouTube) ---
        const secretArns = [
            `arn:aws:secretsmanager:${region}:${account}:secret:pexels/apiKey-*`,
            `arn:aws:secretsmanager:${region}:${account}:secret:elevenlabs/apiKey-*`,
            `arn:aws:secretsmanager:${region}:${account}:secret:youtube/oauth-*`,
        ];
        // brollFn needs Pexels, ttsFn may need ElevenLabs/Polly, uploadFn needs YouTube OAuth
        [brollFn, ttsFn, uploadFn].forEach(fn => {
            fn.addToRolePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue'],
                resources: secretArns,
            }));
        });
        // ECS render task
        const renderTask = new tasks.EcsRunTask(this, 'RenderECS', {
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            cluster: props.cluster,
            taskDefinition: props.rendererTask,
            assignPublicIp: true,
            launchTarget: new tasks.EcsFargateLaunchTarget(),
            containerOverrides: [{
                    containerDefinition: props.rendererTask.defaultContainer,
                    environment: [{ name: 'JOB_ID', value: sfn.JsonPath.stringAt('$.jobId') }],
                }],
            resultPath: '$.render',
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
        const sm = new sfn.StateMachine(this, 'Pipeline', {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: aws_cdk_lib_1.Duration.minutes(20),
        });
        new aws_cdk_lib_1.CfnOutput(this, 'PipelineArn', {
            value: sm.stateMachineArn,
            description: 'Step Functions State Machine ARN',
        });
    }
}
exports.WorkflowStack = WorkflowStack;
