/** @format */

import { readFileSync } from 'fs';
import { Aspects, IAspect, Stack, Stage, Tag } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import { IConstruct } from 'constructs';
import * as YAML from 'yaml';
import { withTemporaryDirectory, TestApp } from './testutil';
import {
  GitHubWorkflow,
  StackCapabilities,
  GitHubActionStep,
  AddGitHubStageOptions,
  GitHubStage,
  GitHubStageProps,
  AwsCredentials,
} from '../src';

let app: TestApp;
beforeEach(() => {
  const tempOutDir = 'stage.out';
  app = new TestApp({
    outdir: tempOutDir,
  });
});

afterEach(() => {
  app.cleanup();
});

describe('github environment', () => {
  test('can specify one github environment at the stage level', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      const stage = new Stage(app, 'MyStack', {
        env: { account: '111111111111', region: 'us-east-1' },
      });

      new Stack(stage, 'MyStack');

      pipeline.addStageWithGitHubOptions(stage, {
        gitHubEnvironment: { name: 'test' },
      });

      app.synth();

      expect(readFileSync(pipeline.workflowPath, 'utf-8')).toContain('environment: test\n');
    });
  });

  // https://github.com/aws/aws-pdk/pull/94/files
  test('aspects are passed between stages from parent app', () => {
    withTemporaryDirectory((dir) => {
      // Example Aspect that we expect to be copied into all of the Stages
      class Tagger implements IAspect {
        public visit(node: IConstruct): void {
          new Tag('TestKey', 'TestValue').visit(node);
        }
      }
      Aspects.of(app).add(new Tagger());

      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      // "Wave" Test: Create a Wave and add the Stage to the Wave. This
      // executes the GithubWave.addStage() call.
      const wave = pipeline.addWave('Wave');
      const stageA = new Stage(app, 'AspectStageA', {
        env: { account: '111111111111', region: 'us-east-1' },
      });
      const stackA = new Stack(stageA, 'MyStackA');
      new Bucket(stackA, 'TestBucket');
      wave.addStage(stageA);

      // "Pipeline" Test: Create a Stage directly from the Pipeline
      const stageB = new Stage(app, 'AspectStageB', {
        env: { account: '111111111111', region: 'us-east-1' },
      });
      const stackB = new Stack(stageB, 'MyStackB');
      new Bucket(stackB, 'TestBucket');
      pipeline.addStage(stageB);

      // First, snapshot test to look for any odd unexpected differences
      const templateA = Template.fromStack(stackA);
      const templateB = Template.fromStack(stackB);
      expect(templateA.toJSON()).toMatchSnapshot();
      expect(templateB.toJSON()).toMatchSnapshot();

      // Next, test that the Bucket in both Stacks (in different stages) have the appropriate tags
      templateA.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([Match.objectEquals({ Key: 'TestKey', Value: 'TestValue' })]),
      });
      templateB.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([Match.objectEquals({ Key: 'TestKey', Value: 'TestValue' })]),
      });
    });
  });

  test('can specify one github environment with url', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      const stage = new Stage(app, 'MyStack', {
        env: { account: '111111111111', region: 'us-east-1' },
      });

      new Stack(stage, 'MyStack');

      pipeline.addStageWithGitHubOptions(stage, {
        gitHubEnvironment: { name: 'test', url: 'test.com' },
      });

      app.synth();

      expect(readFileSync(pipeline.workflowPath, 'utf-8')).toMatch(/.*environment:\s+name: test\s+url: test\.com.*/m);
    });
  });

  test('can specify multiple github environments', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      // Two stages
      const testStage = new Stage(app, 'MyStage1', {
        env: { account: '111111111111', region: 'us-east-1' },
      });
      const prodStage = new GitHubStage(app, 'MyStage2', {
        env: { account: '222222222222', region: 'us-west-2' },
        gitHubEnvironment: { name: 'prod' },
      });

      // Two stacks
      new Stack(testStage, 'MyStack');
      new Stack(prodStage, 'MyStack');

      pipeline.addStageWithGitHubOptions(testStage, {
        gitHubEnvironment: { name: 'test' },
      });
      pipeline.addStage(prodStage);

      app.synth();

      expect(readFileSync(pipeline.workflowPath, 'utf-8')).toMatchSnapshot();
    });
  });
});

describe('cloudformation stack capabilities', () => {
  test('can specify stack capabilities', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      const stage = new Stage(app, 'MyStack', {
        env: { account: '111111111111', region: 'us-east-1' },
      });

      new Stack(stage, 'MyStack');

      pipeline.addStageWithGitHubOptions(stage, {
        stackCapabilities: [StackCapabilities.NAMED_IAM],
      });

      app.synth();

      expect(readFileSync(pipeline.workflowPath, 'utf-8')).toMatchSnapshot();
    });
  });

  test('can specify multiple capabilities', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      const stage = new Stage(app, 'MyStack', {
        env: { account: '111111111111', region: 'us-east-1' },
      });

      new Stack(stage, 'MyStack');

      pipeline.addStageWithGitHubOptions(stage, {
        stackCapabilities: [StackCapabilities.NAMED_IAM, StackCapabilities.IAM, StackCapabilities.AUTO_EXPAND],
      });

      app.synth();

      expect(readFileSync(pipeline.workflowPath, 'utf-8')).toMatchSnapshot();
    });
  });
});

describe('job settings', () => {
  test('can specify job settings at stage level', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
      });

      const stage = new Stage(app, 'MyStack', {
        env: { account: '111111111111', region: 'us-east-1' },
      });

      new Stack(stage, 'MyStack');

      pipeline.addStageWithGitHubOptions(stage, {
        jobSettings: {
          if: "github.repository == 'github/repo'",
        },
      });

      app.synth();

      expect(readFileSync(pipeline.workflowPath, 'utf-8')).toMatchSnapshot();
    });
  });

  test('stage-level job settings override app-level settings', () => {
    withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', {
          installCommands: ['yarn'],
          commands: ['yarn build'],
        }),
        jobSettings: {
          if: "github.repository == 'another/repoA'",
        },
      });

      const stage = new Stage(app, 'MyStack', {
        env: { account: '111111111111', region: 'us-east-1' },
      });

      new Stack(stage, 'MyStack');

      pipeline.addStageWithGitHubOptions(stage, {
        jobSettings: {
          if: "github.repository == 'github/repoB'",
        },
      });

      app.synth();

      const workflowFileContents = readFileSync(pipeline.workflowPath, 'utf-8');
      expect(workflowFileContents).toContain("if: github.repository == 'another/repoA'\n");
      expect(workflowFileContents).toContain("if: github.repository == 'github/repoB'\n");
    });
  });
});

test('can set pre/post github action job step', () => {
  withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Synth', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
      jobSettings: {
        if: 'contains(fromJson(\'["push", "pull_request"]\'), github.event_name)',
      },
    });

    const stage = new GitHubStage(app, 'MyPrePostStack', {
      env: { account: '111111111111', region: 'us-east-1' },
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deploy')",
      },
    });

    new Stack(stage, 'MyStack');

    pipeline.addStage(stage, {
      pre: [
        new GitHubActionStep('PreDeployAction', {
          jobSteps: [
            {
              name: 'pre deploy action',
              uses: 'my-pre-deploy-action@1.0.0',
              with: {
                'app-id': 1234,
                secrets: 'my-secrets',
              },
            },
          ],
        }),
      ],

      post: [
        new GitHubActionStep('PostDeployAction', {
          jobSteps: [
            {
              name: 'Checkout',
              uses: 'actions/checkout@v4',
            },
            {
              name: 'post deploy action',
              uses: 'my-post-deploy-action@1.0.0',
              with: {
                'app-id': 4321,
                secrets: 'secrets',
              },
            },
          ],
        }),
      ],
    });

    app.synth();

    const workflowFileContents = readFileSync(pipeline.workflowPath, 'utf-8');
    expect(workflowFileContents).toMatchSnapshot();
    expect(workflowFileContents).toContain('my-pre-deploy-action@1.0.0');
    expect(workflowFileContents).toContain('my-post-deploy-action@1.0.0');
    expect(workflowFileContents).toContain('actions/checkout@v4');
    expect(workflowFileContents).toContain('contains(fromJson(\'["push", "pull_request"]\'), github.event_name)');
    expect(workflowFileContents).toContain("success() && contains(github.event.issue.labels.*.name, 'deploy')");
  });
});

test('stages in github waves works', () => {
  withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
    });

    const stageA = new Stage(app, 'MyStageA', {
      env: { account: '111111111111', region: 'us-east-1' },
    });

    new Stack(stageA, 'MyStackA');

    const wave = pipeline.addGitHubWave('MyWave');

    const stageAOptions: AddGitHubStageOptions = {
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deployToA')",
      },
    };
    wave.addStageWithGitHubOptions(stageA, stageAOptions);

    const stageBOptions: GitHubStageProps = {
      env: { account: '12345678901', region: 'us-east-1' },
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deployToB')",
      },
    };
    const stageB = new GitHubStage(app, 'MyStageB', stageBOptions);

    new Stack(stageB, 'MyStackB');

    wave.addStage(stageB);

    app.synth();

    const workflowFileContents = readFileSync(pipeline.workflowPath, 'utf-8');
    expect(workflowFileContents).toMatchSnapshot();

    const yaml = YAML.parse(workflowFileContents);
    expect(yaml).toMatchObject({
      jobs: {
        'MyWave-MyStageA-MyStackA-Deploy': {
          if: stageAOptions.jobSettings?.if,
        },
        'MyWave-MyStageB-MyStackB-Deploy': {
          if: stageBOptions.jobSettings?.if,
        },
      },
    });
  });
});

test('github stages in waves works', () => {
  withTemporaryDirectory((dir) => {
    const buildIfStatement =
      "contains(github.event.issue.labels.*.name, 'deployToA') || contains(github.event.issue.labels.*.name, 'deployToB')";
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
      jobSettings: {
        if: buildIfStatement,
      },
    });

    const stageAOptions: GitHubStageProps = {
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deployToA')",
      },
    };
    const stageA = new GitHubStage(app, 'MyStageA', {
      env: { account: '111111111111', region: 'us-east-1' },
      ...stageAOptions,
    });

    new Stack(stageA, 'MyStackA');

    const stageBOptions: GitHubStageProps = {
      env: { account: '12345678901', region: 'us-east-1' },
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deployToB')",
      },
    };
    const stageB = new GitHubStage(app, 'MyStageB', stageBOptions);

    new Stack(stageB, 'MyStackB');

    // Make a wave to have the stages be parallel (not depend on each other)
    const wave = pipeline.addGitHubWave('MyWave', {
      pre: [
        new GitHubActionStep('PreWaveAction', {
          jobSteps: [
            {
              name: 'pre wave action',
              uses: 'my-pre-wave-action@1.0.0',
              with: {
                'app-id': 1234,
                secrets: 'my-secrets',
              },
            },
          ],
        }),
      ],

      post: [
        new GitHubActionStep('PostWaveAction', {
          jobSteps: [
            {
              name: 'Checkout',
              uses: 'actions/checkout@v4',
            },
            {
              name: 'post wave action',
              uses: 'my-post-wave-action@1.0.0',
              with: {
                'app-id': 4321,
                secrets: 'secrets',
              },
            },
          ],
        }),
      ],
    });
    wave.addStage(stageA);
    wave.addStage(stageB);

    app.synth();

    const workflowFileContents = readFileSync(pipeline.workflowPath, 'utf-8');
    expect(workflowFileContents).toMatchSnapshot();

    const yaml = YAML.parse(workflowFileContents);
    expect(yaml).toMatchObject({
      jobs: {
        'Build-Build': {
          if: buildIfStatement,
        },
        'MyWave-MyStageA-MyStackA-Deploy': {
          if: stageAOptions.jobSettings?.if,
        },
        'MyWave-MyStageB-MyStackB-Deploy': {
          if: stageBOptions.jobSettings?.if,
        },
      },
    });
  });
});

test('stages in pipeline works with `if`', () => {
  withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
    });

    const stageA = new Stage(app, 'MyStageA', {
      env: { account: '111111111111', region: 'us-east-1' },
    });

    new Stack(stageA, 'MyStackA');

    const stageAOptions: AddGitHubStageOptions = {
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deployToA')",
      },
    };
    pipeline.addStageWithGitHubOptions(stageA, stageAOptions);

    const stageBOptions: GitHubStageProps = {
      env: { account: '12345678901', region: 'us-east-1' },
      jobSettings: {
        if: "success() && contains(github.event.issue.labels.*.name, 'deployToB')",
      },
    };
    const stageB = new GitHubStage(app, 'MyStageB', stageBOptions);

    new Stack(stageB, 'MyStackB');

    pipeline.addStage(stageB);

    app.synth();

    const workflowFileContents = readFileSync(pipeline.workflowPath, 'utf-8');
    expect(workflowFileContents).toMatchSnapshot();
    expect(workflowFileContents).toContain('actions/checkout@v4');

    const yaml = YAML.parse(workflowFileContents);
    expect(yaml).toMatchObject({
      jobs: {
        'MyStageA-MyStackA-Deploy': {
          if: stageAOptions.jobSettings?.if,
        },
        'MyStageB-MyStackB-Deploy': {
          if: stageBOptions.jobSettings?.if,
        },
      },
    });
  });
});

test('create stages with different awsCreds', () => {
  withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      awsCreds: AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: 'arn:...' }),
      synth: new ShellStep('Build', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
    });

    // Should use the github role arn from the workflow
    const stageA = new Stage(app, 'MyStageA', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    new Stack(stageA, 'MyStackA');
    pipeline.addStage(stageA);

    // Should use its own aws credentials that are supplied
    const stageB = new GitHubStage(app, 'MyStageB', {
      env: { account: '222222222222', region: 'us-east-1' },
      awsCreds: AwsCredentials.fromGitHubSecrets({ accessKeyId: 'abcd', secretAccessKey: '1234' }),
    });
    new Stack(stageB, 'MyStackB');
    pipeline.addStage(stageB);

    // Should use its own aws credentials that are supplied
    const stageC = new GitHubStage(app, 'MyStageC', {
      env: { account: '222222222222', region: 'us-east-1' },
    });
    new Stack(stageC, 'MyStackC');
    pipeline.addStageWithGitHubOptions(stageC, {
      awsCreds: AwsCredentials.fromGitHubSecrets(),
    });

    app.synth();

    const workflowFileContents = readFileSync(pipeline.workflowPath, 'utf-8');
    expect(workflowFileContents).toMatchSnapshot();
    expect(workflowFileContents).toContain('actions/checkout@v4');

    const yaml = YAML.parse(workflowFileContents);
    expect(yaml).toMatchObject({
      jobs: {
        'MyStageA-MyStackA-Deploy': {
          name: 'Deploy MyStageA/MyStackA',
          permissions: {
            contents: 'read',
            'id-token': 'write',
          },
          steps: expect.arrayContaining([
            {
              name: 'Authenticate Via OIDC Role',
              uses: 'aws-actions/configure-aws-credentials@v4',
              with: {
                'aws-region': 'us-east-1',
                'role-duration-seconds': 1800,
                'role-skip-session-tagging': true,
                'role-to-assume': 'arn:...',
              },
            },
          ]),
        },
      },
    });
    expect(yaml).toMatchObject({
      jobs: {
        'MyStageB-MyStackB-Deploy': {
          name: 'Deploy MyStageB/MyStackB',
          permissions: {
            contents: 'read',
          },
          steps: expect.arrayContaining([
            {
              name: 'Authenticate Via GitHub Secrets',
              uses: 'aws-actions/configure-aws-credentials@v4',
              with: {
                'aws-access-key-id': '${{ secrets.abcd }}',
                'aws-secret-access-key': '${{ secrets.1234 }}',
                'aws-region': 'us-east-1',
                'role-duration-seconds': 1800,
                'role-skip-session-tagging': true,
              },
            },
          ]),
        },
      },
    });
    expect(yaml).toMatchObject({
      jobs: {
        'MyStageC-MyStackC-Deploy': {
          name: 'Deploy MyStageC/MyStackC',
          permissions: {
            contents: 'read',
          },
          steps: expect.arrayContaining([
            {
              name: 'Authenticate Via GitHub Secrets',
              uses: 'aws-actions/configure-aws-credentials@v4',
              with: {
                'aws-access-key-id': '${{ secrets.AWS_ACCESS_KEY_ID }}',
                'aws-secret-access-key': '${{ secrets.AWS_SECRET_ACCESS_KEY }}',
                'aws-region': 'us-east-1',
                'role-duration-seconds': 1800,
                'role-skip-session-tagging': true,
              },
            },
          ]),
        },
      },
    });
  });
});

test('stages added to a pipeline after build will fail', () => {
  withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
    });

    const stageA = new Stage(app, 'MyStageA', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    new Stack(stageA, 'MyStackA');
    pipeline.addStageWithGitHubOptions(stageA, {});

    const stageB = new GitHubStage(app, 'MyStageB', {});
    new Stack(stageB, 'MyStackB');

    app.synth();

    expect(() => pipeline.addStage(stageB)).toThrowErrorMatchingInlineSnapshot(
      '"addStage: can\'t add Stages anymore after buildPipeline() has been called"',
    );
  });
});

// cannot test adding a stage to a GitHubWave post-build, since Waves to not throw an error in that case...

test('waves added to a pipeline after build will fail', () => {
  withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', {
        installCommands: ['yarn'],
        commands: ['yarn build'],
      }),
    });

    const wave = pipeline.addGitHubWave('wave');

    const stageA = new Stage(app, 'MyStageA', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    new Stack(stageA, 'MyStackA');
    wave.addStage(stageA, {});

    const stageB = new GitHubStage(app, 'MyStageB', {});
    new Stack(stageB, 'MyStackB');

    app.synth();

    expect(() => pipeline.addGitHubWave('wave2')).toThrowErrorMatchingInlineSnapshot(
      '"addWave: can\'t add Waves anymore after buildPipeline() has been called"',
    );
  });
});
