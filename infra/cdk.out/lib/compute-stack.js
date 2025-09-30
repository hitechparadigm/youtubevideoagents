import { Stack, CfnOutput } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
export class ComputeStack extends Stack {
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
        new CfnOutput(this, 'RendererRepoUri', { value: repo.repositoryUri });
    }
}
