/** @format */

import * as github from '../workflows-model';

export const DEFAULT_SESSION_DURATION: number = 30 * 60;
export const DEFAULT_REGION: string = 'us-east-1';

interface AwsCredentialsStepProps {
  /**
   * @default undefined
   */
  readonly roleToAssume?: string;

  /**
   * @default undefined
   */
  readonly roleExternalId?: string;

  /**
   * @default true
   */
  readonly roleSkipSessionTagging?: boolean;

  /**
   * The GitHub Action role session name.
   *
   * @default - no role session name passed into aws creds step
   */
  readonly roleSessionName?: string;

  /**
   * The maximum time that the session should be valid for. Default is 1800s,
   * but can be extended for longer deployments or tests.
   *
   * @default DEFAULT_SESSION_DURATION
   */
  readonly sessionDuration?: number;

  /**
   * The AWS Region.
   */
  readonly region?: string;

  /**
   * To authenticate via GitHub secrets, at least this and `secretAccessKey` must
   * be provided. Alternatively, provide just an `oidcRoleArn`.
   *
   * @default undefined
   */
  readonly accessKeyId?: string;

  /**
   * To authenticate via GitHub secrets, at least this and `accessKeyId` must
   * be provided. Alternatively, provide just an `oidcRoleArn`.
   *
   * @default undefined
   */
  readonly secretAccessKey?: string;

  /**
   * Provide an AWS session token.
   *
   * @default undefined
   */
  readonly sessionToken?: string;
}

export function awsCredentialStep(stepName: string, props: AwsCredentialsStepProps): github.JobStep {
  const params: Record<string, any> = {};

  params['aws-region'] = props.region || DEFAULT_REGION;
  params['role-duration-seconds'] = props.sessionDuration || DEFAULT_SESSION_DURATION;

  // Session tagging requires the role to have `sts:TagSession` permissions,
  // which CDK bootstrapped roles do not currently have.
  params['role-skip-session-tagging'] = props.roleSkipSessionTagging ?? true;

  params['aws-access-key-id'] = props.accessKeyId;
  params['aws-secret-access-key'] = props.secretAccessKey;
  if (props.sessionToken) {
    params['aws-session-token'] = props.sessionToken;
  }

  if (props.roleToAssume) {
    params['role-to-assume'] = props.roleToAssume;
  }
  if (props.roleExternalId) {
    params['role-external-id'] = props.roleExternalId;
  }

  if (props.roleSessionName) {
    params['role-session-name'] = props.roleSessionName;
  }

  return {
    name: stepName,
    uses: 'aws-actions/configure-aws-credentials@v4',
    with: params,
  };
}
