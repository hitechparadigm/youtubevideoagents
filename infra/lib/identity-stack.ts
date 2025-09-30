import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class IdentityStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com']
    });

    const conditions = {
      StringLike: {
        'token.actions.githubusercontent.com:sub':
          'repo:hitechparadigm/youtubevideoagents:ref:refs/heads/main',
      },
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
    };

    new iam.Role(this, 'GithubCdkDeployRole', {
      roleName: 'GithubCdkDeployRole',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, conditions),
      managedPolicies: [
        // Start broad for CDK bootstrap; tighten later
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      ],
      description: 'OIDC role for GitHub Actions (hitechparadigm/youtubevideoagents)',
    });
  }
}
