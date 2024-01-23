/** @format */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { Stage } from 'aws-cdk-lib';
import {
  PipelineBase,
  PipelineBaseProps,
  ShellStep,
  StackDeployment,
  StackOutputReference,
  StageDeployment,
  Step,
  Wave,
  WaveOptions,
} from 'aws-cdk-lib/pipelines';
import { AGraphNode, Graph, PipelineGraph, isGraph } from 'aws-cdk-lib/pipelines/lib/helpers-internal';
import { Construct } from 'constructs';
import * as decamelize from 'decamelize';
import { AwsCredentials, AwsCredentialsProvider } from './aws-credentials';
import { AddGitHubStageOptions, GitHubEnvironment } from './github-common';
import { GitHubStage } from './stage';
import { GitHubActionStep } from './steps/github-action-step';
import { GitHubWave } from './wave';
import * as github from './workflows-model';
import { YamlFile } from './yaml-file';

const CDK_OUT_ARTIFACT_NAME = 'cdk.out';
const CDK_OUT_ARTIFACT_PATH = 'cdk.out.tgz';
const RETENTION_DAYS = 1;

/**
 * Job level settings applied to all jobs in the workflow.
 */
export interface JobSettings {
  /**
   * jobs.<job_id>.if.
   *
   * @see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idif
   */
  readonly if?: string;
}

/**
 * Props for `GitHubWorkflow`.
 */
export interface GitHubWorkflowProps extends PipelineBaseProps {
  /**
   * File path for the GitHub workflow.
   *
   * @default ".github/workflows/deploy.yml"
   */
  readonly workflowPath?: string;

  /**
   * Name of the workflow.
   *
   * @default "deploy"
   */
  readonly workflowName?: string;

  /**
   * GitHub workflow triggers.
   *
   * @default - By default, workflow is triggered on push to the `main` branch
   * and can also be triggered manually (`workflow_dispatch`).
   */
  readonly workflowTriggers?: github.WorkflowTriggers;

  /**
   * Version of the CDK CLI to use.
   * @default - automatic
   */
  readonly cdkCliVersion?: string;

  /**
   * Configure provider for AWS credentials used for deployment.
   *
   * @default - Get AWS credentials from GitHub secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
   */
  readonly awsCreds?: AwsCredentialsProvider;

  /**
   * Build container options.
   *
   * @default - GitHub defaults
   */
  readonly buildContainer?: github.ContainerOptions;

  /**
   * The type of Github Runner that the build workflow runs on.
   *
   * @default Runner.UBUNTU_LATEST
   */
  readonly buildRunner?: github.Runner;

  /**
   * GitHub workflow steps to execute before build.
   *
   * @default []
   */
  readonly preBuildSteps?: github.JobStep[];

  /**
   * GitHub workflow steps to execute after build.
   *
   * @default []
   */
  readonly postBuildSteps?: github.JobStep[];

  /**
   * What approval level is required for deployments? By default this is
   * `never` to ensure that all automated deployments succeed.
   *
   * @default "never"
   */
  readonly requireApproval?: 'never' | 'any-change' | 'broadening';

  /**
   * Optional deploy aguments appended to the `cdk deploy ...` command.
   */
  readonly deployArgs?: string[];

  /**
   * Whether or not to run a "diff" job first. Adds some time to the deploy
   * process, but useful for understanding what changes are being applied.
   */
  readonly diffFirst?: boolean;

  /**
   * The type of runner that the entire workflow runs on. You can also set the
   * runner specifically for the `build` (synth) step separately.
   *
   * @default Runner.UBUNTU_LATEST
   */
  readonly runner?: github.Runner;

  /**
   * Job level settings that will be applied to all jobs in the workflow,
   * including synth and asset deploy jobs. Currently the only valid setting
   * is 'if'. You can use this to run jobs only in specific repositories.
   *
   * @see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#example-only-run-job-for-specific-repository
   */
  readonly jobSettings?: JobSettings;
}

/**
 * CDK Pipelines for GitHub workflows.
 */
export class GitHubWorkflow extends PipelineBase {
  public readonly workflowPath: string;
  public readonly workflowName: string;
  public readonly workflowFile: YamlFile;

  private readonly awsCredentials: AwsCredentialsProvider;
  private readonly cdkoutDir: string;
  private readonly workflowTriggers: github.WorkflowTriggers;
  private readonly buildContainer?: github.ContainerOptions;
  private readonly buildRunner: github.Runner;
  private readonly preBuildSteps: github.JobStep[];
  private readonly postBuildSteps: github.JobStep[];
  private readonly deployArgs: string[];
  private readonly diffFirst: boolean;
  private readonly jobOutputs: Record<string, github.JobStepOutput[]> = {};
  private readonly runner: github.Runner;
  private readonly stackProperties: Record<
    string,
    {
      environment: AddGitHubStageOptions['gitHubEnvironment'];
      capabilities: AddGitHubStageOptions['stackCapabilities'];
      settings: AddGitHubStageOptions['jobSettings'];
    }
  > = {};
  private readonly jobSettings?: JobSettings;

  // in order to keep track of if this pipeline has been built so we can
  // catch later calls to addWave() or addStage()
  private builtGH = false;

  constructor(scope: Construct, id: string, props: GitHubWorkflowProps) {
    super(scope, id, props);

    this.awsCredentials = props.awsCreds || AwsCredentials.fromGitHubSecrets();
    this.buildContainer = props.buildContainer;
    this.preBuildSteps = props.preBuildSteps ?? [];
    this.postBuildSteps = props.postBuildSteps ?? [];
    this.jobSettings = props.jobSettings;
    this.diffFirst = props.diffFirst ?? false;
    this.deployArgs = props.deployArgs ?? [];
    this.workflowPath = props.workflowPath ?? '.github/workflows/deploy.yml';

    if (!this.workflowPath.endsWith('.yml') && !this.workflowPath.endsWith('.yaml')) {
      throw new Error('workflow file is expected to be a yaml file');
    }
    if (!this.workflowPath.includes('.github/workflows/')) {
      throw new Error("workflow files must be stored in the '.github/workflows' directory of your repository");
    }

    this.workflowFile = new YamlFile(this.workflowPath);
    this.workflowName = props.workflowName ?? 'deploy';
    this.workflowTriggers = props.workflowTriggers ?? {
      push: { branches: ['main'] },
      workflowDispatch: {},
    };

    const app = Stage.of(this);
    if (!app) {
      throw new Error('The GitHub Workflow must be defined in the scope of an App');
    }
    this.cdkoutDir = app.outdir;

    this.runner = props.runner ?? github.Runner.UBUNTU_LATEST;
    this.buildRunner = props.buildRunner ?? this.runner;

    /** By default, deploy! */
    this.deployArgs.push(`--require-approval=${props.requireApproval ?? 'never'}`);

    /** The pipeline handles dependency ordering, no need to re-deploy dependency stacks */
    this.deployArgs.push('--exclusively');
  }

  /**
   * Deploy a single Stage by itself with options for further GitHub configuration.
   *
   * Add a Stage to the pipeline, to be deployed in sequence with other Stages added to the pipeline.
   * All Stacks in the stage will be deployed in an order automatically determined by their relative dependencies.
   */
  public addStageWithGitHubOptions(stage: Stage, options?: AddGitHubStageOptions): StageDeployment {
    const stageDeployment = this.addStage(stage, options);

    // keep track of GitHub specific options
    const stacks = stageDeployment.stacks;
    this.addStackProps(stacks, 'environment', options?.gitHubEnvironment);
    this.addStackProps(stacks, 'capabilities', options?.stackCapabilities);
    this.addStackProps(stacks, 'settings', options?.jobSettings);

    return stageDeployment;
  }

  /**
   * Add a Wave to the pipeline, for deploying multiple Stages in parallel
   *
   * Use the return object of this method to deploy multiple stages in parallel.
   *
   * Example:
   *
   * ```ts
   * declare const pipeline: GitHubWorkflow; // assign pipeline a value
   *
   * const wave = pipeline.addWave('MyWave');
   * wave.addStage(new MyStage(this, 'Stage1'));
   * wave.addStage(new MyStage(this, 'Stage2'));
   * ```
   */
  public addWave(id: string, options?: WaveOptions): Wave {
    return this.addGitHubWave(id, options);
  }

  public addGitHubWave(id: string, options?: WaveOptions): GitHubWave {
    if (this.builtGH) {
      throw new Error("addWave: can't add Waves anymore after buildPipeline() has been called");
    }

    const wave = new GitHubWave(id, this, options);
    this.waves.push(wave);
    return wave;
  }

  /**
   * Support adding stages with GitHub options to waves - should ONLY be called internally.
   *
   * Use `pipeline.addWave()` and it'll call this when `wave.addStage()` is called.
   *
   * `pipeline.addStage()` will also call this, since it calls `pipeline.addWave().addStage()`.
   *
   *  @internal
   */
  public _addStageFromWave(stage: Stage, stageDeployment: StageDeployment, options?: AddGitHubStageOptions) {
    if (!(stage instanceof GitHubStage) && options === undefined) {
      return;
    }

    const ghStage = stage instanceof GitHubStage ? stage : undefined;

    // keep track of GitHub specific options
    const stacks = stageDeployment.stacks;
    this.addStackProps(stacks, 'environment', ghStage?.props?.gitHubEnvironment ?? options?.gitHubEnvironment);
    this.addStackProps(stacks, 'capabilities', ghStage?.props?.stackCapabilities ?? options?.stackCapabilities);
    this.addStackProps(stacks, 'settings', ghStage?.props?.jobSettings ?? options?.jobSettings);
  }

  private addStackProps(stacks: StackDeployment[], key: string, value: any) {
    if (value === undefined) {
      return;
    }
    for (const stack of stacks) {
      this.stackProperties[stack.stackArtifactId] = {
        ...this.stackProperties[stack.stackArtifactId],
        [key]: value,
      };
    }
  }

  protected doBuildPipeline() {
    this.builtGH = true;

    const app = Stage.of(this);

    if (!app) {
      throw new Error('The GitHub Workflow must be defined in the scope of an App');
    }

    const jobs = new Array<Job>();

    const structure = new PipelineGraph(this, {
      selfMutation: false,
      publishTemplate: false, // all deploys are run via the cdk cli
      prepareStep: false, // we create and execute the changeset in a single job
    });

    for (const stageNode of flatten(structure.graph.sortedChildren())) {
      if (!isGraph(stageNode)) {
        throw new Error(`Top-level children must be graphs, got '${stageNode}'`);
      }

      const tranches = stageNode.sortedLeaves();

      for (const tranche of tranches) {
        for (const node of tranche) {
          const job = this.jobForNode(node);

          if (job) {
            jobs.push(job);
          }
        }
      }
    }

    // convert jobs to a map and make sure there are no duplicates
    const jobmap: Record<string, github.Job> = {};
    for (const job of jobs) {
      if (job.id in jobmap) {
        throw new Error(`duplicate job id ${job.id}`);
      }
      jobmap[job.id] = snakeCaseKeys(job.definition);
    }

    // Update jobs with late-bound output requests
    this.insertJobOutputs(jobmap);

    const workflow = {
      name: this.workflowName,
      on: snakeCaseKeys(this.workflowTriggers, '_'),
      jobs: jobmap,
    };

    // write as a yaml file
    this.workflowFile.update(workflow);

    // create directory if it does not exist
    mkdirSync(path.dirname(this.workflowPath), { recursive: true });

    // GITHUB_WORKFLOW is set when GitHub Actions is running the workflow.
    // see: https://docs.github.com/en/actions/learn-github-actions/environment-variables#default-environment-variables
    const contextValue = this.node.tryGetContext('cdk-pipelines-github:diffProtection');
    const diffProtection = contextValue === 'false' ? false : contextValue ?? true;
    if (diffProtection && process.env.GITHUB_WORKFLOW === this.workflowName) {
      // check if workflow file has changed
      if (!existsSync(this.workflowPath) || this.workflowFile.toYaml() !== readFileSync(this.workflowPath, 'utf8')) {
        throw new Error(
          `Please commit the updated workflow file ${path.relative(
            __dirname,
            this.workflowPath,
          )} when you change your pipeline definition.`,
        );
      }
    }

    this.workflowFile.writeFile();
  }

  private insertJobOutputs(jobmap: Record<string, github.Job>) {
    for (const [jobId, jobOutputs] of Object.entries(this.jobOutputs)) {
      jobmap[jobId] = {
        ...jobmap[jobId],
        outputs: {
          ...jobmap[jobId].outputs,
          ...this.renderJobOutputs(jobOutputs),
        },
      };
    }
  }

  private renderJobOutputs(outputs: github.JobStepOutput[]) {
    const renderedOutputs: Record<string, string> = {};
    for (const output of outputs) {
      renderedOutputs[output.outputName] = `\${{ steps.${output.stepId}.outputs.${output.outputName} }}`;
    }
    return renderedOutputs;
  }

  /**
   * Make an action from the given node and/or step
   */
  private jobForNode(node: AGraphNode): Job | undefined {
    switch (node.data?.type) {
      // Nothing for these, they are groupings (shouldn't even have popped up here)
      case 'group':
      case 'stack-group':
      case undefined:
        throw new Error(`jobForNode: did not expect to get group nodes: ${node.data?.type}`);

      case 'publish-assets':
        return;

      case 'self-update':
        throw new Error('GitHub Workflows does not support self mutation');

      case 'prepare':
        throw new Error('"prepare" is not supported by GitHub Workflows');

      case 'execute':
        return this.jobForDeploy(node, node.data.stack, node.data.captureOutputs);

      case 'step':
        if (node.data.isBuildStep) {
          return this.jobForBuildStep(node, node.data.step);
        } else if (node.data.step instanceof ShellStep) {
          return this.jobForScriptStep(node, node.data.step);
        } else if (node.data.step instanceof GitHubActionStep) {
          return this.jobForGitHubActionStep(node, node.data.step);
        } else {
          throw new Error(`unsupported step type: ${node.data.step.constructor.name}`);
        }

      default:
        // The 'as any' is temporary, until the change upstream rolls out
        throw new Error(
          `GitHubWorfklow does not support graph nodes of type '${(node.data as any)
            ?.type}'. You are probably using a feature this CDK Pipelines implementation does not support.`,
        );
    }
  }

  private jobForDeploy(node: AGraphNode, stack: StackDeployment, _captureOutputs: boolean): Job {
    const region = stack.region;
    const account = stack.account;

    if (!region || !account) {
      throw new Error('"account" and "region" are required');
    }

    return {
      id: node.uniqueId,
      definition: {
        name: `Deploy ${stack.constructPath}`,
        ...this.renderJobSettingParameters(),
        ...this.stackProperties[stack.stackArtifactId]?.settings,
        permissions: {
          contents: github.JobPermission.READ,
          idToken: this.awsCredentials.jobPermission(),
        },
        ...this.renderGitHubEnvironment(this.stackProperties[stack.stackArtifactId]?.environment),
        needs: this.renderDependencies(node),
        runsOn: this.runner.runsOn,
        steps: [
          ...this.stepsToUnpackageAssembly,
          ...this.awsCredentials.credentialSteps(region),
          ...this.stepsToDeploy(stack),
        ],
      },
    };
  }

  private jobForBuildStep(node: AGraphNode, step: Step): Job {
    if (!(step instanceof ShellStep)) {
      throw new Error('synthStep must be a ScriptStep');
    }

    if (step.inputs.length > 0) {
      throw new Error('synthStep cannot have inputs');
    }

    if (step.outputs.length > 1) {
      throw new Error('synthStep must have a single output');
    }

    if (!step.primaryOutput) {
      throw new Error('synthStep requires a primaryOutput which contains cdk.out');
    }

    const installSteps =
      step.installCommands.length > 0
        ? [
            {
              name: 'Install',
              run: step.installCommands.join('\n'),
            },
          ]
        : [];

    return {
      id: node.uniqueId,
      definition: {
        name: 'Synthesize',
        ...this.renderJobSettingParameters(),
        permissions: {
          contents: github.JobPermission.READ,
          // The Synthesize job does not use the GitHub Action Role on its own, but it's possible
          // that it is being used in the preBuildSteps.
          idToken: this.awsCredentials.jobPermission(),
        },
        runsOn: this.buildRunner.runsOn,
        needs: this.renderDependencies(node),
        env: step.env,
        container: this.buildContainer,
        steps: [
          ...this.stepsToCheckout(),
          ...this.preBuildSteps,
          ...installSteps,
          ...this.awsCredentials.credentialSteps(),
          { name: 'Build', run: step.commands.join('\n') },
          ...this.postBuildSteps,
          ...this.stepsToPackageAssembly,
        ],
      },
    };
  }

  /**
   * Searches for the stack that produced the output via the current
   * job's dependencies.
   *
   * This function should always find a stack, since it is guaranteed
   * that a CfnOutput comes from a referenced stack.
   */
  private findStackOfOutput(ref: StackOutputReference, node: AGraphNode) {
    for (const dep of node.allDeps) {
      if (dep.data?.type === 'execute' && ref.isProducedBy(dep.data.stack)) {
        return dep.uniqueId;
      }
    }
    // Should never happen
    throw new Error(`The output ${ref.outputName} is not referenced by any of the dependent stacks!`);
  }

  private addJobOutput(jobId: string, output: github.JobStepOutput) {
    if (this.jobOutputs[jobId] === undefined) {
      this.jobOutputs[jobId] = [output];
    } else {
      this.jobOutputs[jobId].push(output);
    }
  }

  private jobForScriptStep(node: AGraphNode, step: ShellStep): Job {
    const envVariables: Record<string, string> = {};
    for (const [envName, ref] of Object.entries(step.envFromCfnOutputs)) {
      const jobId = this.findStackOfOutput(ref, node);
      this.addJobOutput(jobId, {
        outputName: ref.outputName,
        stepId: 'Deploy',
      });
      envVariables[envName] = `\${{ needs.${jobId}.outputs.${ref.outputName} }}`;
    }

    const downloadInputs = new Array<github.JobStep>();
    const uploadOutputs = new Array<github.JobStep>();

    for (const input of step.inputs) {
      downloadInputs.push(...this.stepsToDownloadArtifact(input.fileSet.id, input.directory));
    }

    for (const output of step.outputs) {
      uploadOutputs.push(...this.stepsToUplodArtifact(output.fileSet.id, output.directory));
    }

    const installSteps =
      step.installCommands.length > 0
        ? [
            {
              name: 'Install',
              run: step.installCommands.join('\n'),
            },
          ]
        : [];

    return {
      id: node.uniqueId,
      definition: {
        name: step.id,
        ...this.renderJobSettingParameters(),
        permissions: {
          contents: github.JobPermission.READ,
        },
        runsOn: this.runner.runsOn,
        needs: this.renderDependencies(node),
        env: {
          ...step.env,
          ...envVariables,
        },
        steps: [...downloadInputs, ...installSteps, { run: step.commands.join('\n') }, ...uploadOutputs],
      },
    };
  }

  private jobForGitHubActionStep(node: AGraphNode, step: GitHubActionStep): Job {
    return {
      id: node.uniqueId,
      definition: {
        name: step.id,
        ...this.renderJobSettingParameters(),
        permissions: {
          contents: github.JobPermission.WRITE,
        },
        runsOn: this.runner.runsOn,
        needs: this.renderDependencies(node),
        env: step.env,
        steps: step.jobSteps,
      },
    };
  }

  private stepsToCheckout(): github.JobStep[] {
    return [
      {
        name: 'Checkout',
        uses: 'actions/checkout@v3',
      },
    ];
  }

  private get stepsToPackageAssembly() {
    return [
      {
        name: `Package ${CDK_OUT_ARTIFACT_NAME}`,
        run: `tar -zcf ${CDK_OUT_ARTIFACT_PATH} ${this.cdkoutDir}`,
      },
      ...this.stepsToUplodArtifact(CDK_OUT_ARTIFACT_NAME, CDK_OUT_ARTIFACT_PATH, true),
    ];
  }

  private get stepsToUnpackageAssembly() {
    return [
      ...this.stepsToDownloadArtifact(CDK_OUT_ARTIFACT_NAME),
      {
        name: `Unpackage ${CDK_OUT_ARTIFACT_NAME}`,
        run: `tar -zxf ${CDK_OUT_ARTIFACT_PATH}`,
      },
    ];
  }

  private stepsToUplodArtifact(name: string, sourcePath: string, errIfNoFilesFound: boolean = false): github.JobStep[] {
    return [
      {
        name: `Upload ${name}`,
        uses: 'actions/upload-artifact@v3',
        with: {
          name: name,
          path: sourcePath,
          'retention-days': RETENTION_DAYS,
          'if-no-files-found': errIfNoFilesFound == true ? 'error' : undefined,
        },
      },
    ];
  }

  private stepsToDownloadArtifact(name: string, targetPath?: string): github.JobStep[] {
    return [
      {
        name: `Download ${name}`,
        uses: 'actions/download-artifact@v3',
        with: {
          name: name,
          path: targetPath,
        },
      },
    ];
  }

  private stepsToDeploy(stack: StackDeployment): github.JobStep[] {
    var steps: github.JobStep[] = [];
    if (this.diffFirst) {
      steps.push({
        id: 'Diff',
        run: `npx cdk --app ${this.cdkoutDir} diff ${stack.constructPath}`,
      });
    }
    steps.push({
      id: 'Deploy',
      run: `npx cdk --app ${this.cdkoutDir} deploy ${stack.constructPath} ${this.deployArgs.join(' ')}`,
    });

    return steps;
  }

  private renderDependencies(node: AGraphNode) {
    const deps = new Array<AGraphNode>();

    for (const d of node.allDeps) {
      if (d.data?.type == 'publish-assets') {
        // skip - we do no asset publishing in our build steps
      } else if (d instanceof Graph) {
        deps.push(...d.allLeaves().nodes);
      } else {
        deps.push(d);
      }
    }

    return deps.map((x) => x.uniqueId);
  }

  private renderJobSettingParameters() {
    return this.jobSettings;
  }

  private renderGitHubEnvironment(environment?: GitHubEnvironment) {
    if (!environment) {
      return {};
    }
    if (environment.url === undefined) {
      return { environment: environment.name };
    }
    return { environment };
  }
}

interface Job {
  readonly id: string;
  readonly definition: github.Job;
}

function snakeCaseKeys<T = unknown>(obj: T, sep = '-'): T {
  if (typeof obj !== 'object' || obj == null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((o) => snakeCaseKeys(o, sep)) as any;
  }

  const result: Record<string, unknown> = {};
  for (let [k, v] of Object.entries(obj)) {
    // we don't want to snake case environment variables
    if (k !== 'env' && typeof v === 'object' && v != null) {
      v = snakeCaseKeys(v);
    }
    result[decamelize(k, { separator: sep })] = v;
  }
  return result as any;
}

/**
 * Names of secrets for AWS credentials.
 */
export interface AwsCredentialsSecrets {
  /**
   * @default "AWS_ACCESS_KEY_ID"
   */
  readonly accessKeyId?: string;

  /**
   * @default "AWS_SECRET_ACCESS_KEY"
   */
  readonly secretAccessKey?: string;

  /**
   * @default - no session token is used
   */
  readonly sessionToken?: string;
}

export function* flatten<A>(xs: Iterable<A[]>): IterableIterator<A> {
  for (const x of xs) {
    for (const y of x) {
      yield y;
    }
  }
}
