import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class WorkflowStack extends Stack {
  constructor(
    scope: Construct, id: string,
    props: StackProps & {
      mediaBucket: s3.Bucket,
      jobsTable: dynamodb.Table,
      rendererTask: ecs.FargateTaskDefinition,
      cluster: ecs.Cluster
    }
  ) {
    super(scope, id, props);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    const common: Omit<lambda.FunctionProps, 'code'> = {
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: Duration.seconds(60),
      memorySize: 512,
      handler: 'app.handler',
      environment: {
        MEDIA_BUCKET: props.mediaBucket.bucketName,
        JOBS_TABLE: props.jobsTable.tableName,
      },
    };

    // ---- Lambdas ----
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
      timeout: Duration.seconds(120),
      code: lambda.Code.fromAsset('../services'),
    });

    // ---- Data access ----
    props.mediaBucket.grantReadWrite(scriptFn);
    props.mediaBucket.grantReadWrite(ttsFn);
    props.mediaBucket.grantReadWrite(brollFn);
    props.mediaBucket.grantReadWrite(uploadFn);

    props.jobsTable.grantReadWriteData(scriptFn);
    props.jobsTable.grantReadWriteData(uploadFn);

    // ---- Permissions: Bedrock for scriptFn ----
    scriptFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${region}::foundation-model/*`],
      effect: iam.Effect.ALLOW,
    }));

    // ---- Permissions: Polly for ttsFn ----
    ttsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
      effect: iam.Effect.ALLOW,
    }));

    // ---- Permissions: Secrets Manager (Pexels / ElevenLabs / YouTube) ----
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

    // ---- ECS render task ----
    const renderTask = new tasks.EcsRunTask(this, 'RenderECS', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster: props.cluster,
      taskDefinition: props.rendererTask,
      assignPublicIp: true,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      containerOverrides: [{
        containerDefinition: props.rendererTask.defaultContainer!,
        environment: [{ name: 'JOB_ID', value: sfn.JsonPath.stringAt('$.jobId') }],
      }],
      resultPath: '$.render',
    });

    // ---- Steps ----
    const scriptStep = new tasks.LambdaInvoke(this, 'Script', { lambdaFunction: scriptFn, resultPath: '$.script' });
    const ttsStep    = new tasks.LambdaInvoke(this, 'TTS',    { lambdaFunction: ttsFn,    resultPath: '$.tts'    });
    const brollStep  = new tasks.LambdaInvoke(this, 'Broll',  { lambdaFunction: brollFn,  resultPath: '$.broll'  });
    const uploadStep = new tasks.LambdaInvoke(this, 'Upload', { lambdaFunction: uploadFn, resultPath: '$.upload' });

    const definition = sfn.Chain
      .start(scriptStep)
      .next(ttsStep)
      .next(brollStep)
      .next(renderTask)
      .next(uploadStep);

    const sm = new sfn.StateMachine(this, 'Pipeline', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(20),
    });

    new CfnOutput(this, 'PipelineArn', {
      value: sm.stateMachineArn,
      description: 'Step Functions State Machine ARN',
    });
  }
}
