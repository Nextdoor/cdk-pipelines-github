/** @format */

import { Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AwsCredentialsProvider } from './aws-credentials';
import { AwsCredsCommonProps, GitHubCommonProps } from './github-common';

export interface GitHubStageProps extends StageProps, GitHubCommonProps, AwsCredsCommonProps {}

export class GitHubStage extends Stage {
  public awsCreds?: AwsCredentialsProvider;
  constructor(
    scope: Construct,
    id: string,
    public readonly props?: GitHubStageProps,
  ) {
    super(scope, id, props);
    this.awsCreds = props?.awsCreds;
  }
}
