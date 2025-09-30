#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreStack } from '../lib/core-stack';
import { ComputeStack } from '../lib/compute-stack';
import { WorkflowStack } from '../lib/workflow-stack';
import { IdentityStack } from '../lib/identity-stack';
const app = new cdk.App();
const identity = new IdentityStack(app, 'VideoGithubOidc', {});
const core = new CoreStack(app, 'VideoCore', {});
const compute = new ComputeStack(app, 'VideoCompute', {
    mediaBucket: core.mediaBucket
});
new WorkflowStack(app, 'VideoWorkflow', {
    mediaBucket: core.mediaBucket,
    jobsTable: core.jobsTable,
    rendererTask: compute.rendererTask,
    cluster: compute.cluster
});
