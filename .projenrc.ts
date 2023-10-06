/** @format */

import { JsonPatch } from 'projen';
import { AwsCdkConstructLibrary } from 'projen/lib/awscdk';
import { NpmAccess, UpdateSnapshot } from 'projen/lib/javascript';

const project = new AwsCdkConstructLibrary({
  projenrcTs: true,
  name: '@nextdoor/cdk-pipelines-github',
  description: 'GitHub Workflows support for CDK Pipelines',
  author: 'Amazon Web Services',
  authorAddress: 'aws-cdk-dev@amazon.com',
  cdkVersion: '2.9.0',
  constructsVersion: '10.0.46',
  defaultReleaseBranch: 'nextdoor',
  repositoryUrl: 'https://github.com/Nextdoor/cdk-pipelines-github.git',
  bundledDeps: ['decamelize', 'yaml', 'fast-json-patch'],
  devDeps: [
    'cdklabs-projen-project-types',
    'aws-cdk-lib',
    '@aws-cdk/integ-runner@^2.60.0',
    '@aws-cdk/integ-tests-alpha',
  ],
  peerDeps: ['aws-cdk-lib'],
  jestOptions: {
    updateSnapshot: UpdateSnapshot.NEVER,
  },

  /**
   * Automatic publishing of our packages to Github Packages as a private package.
   */
  npmAccess: NpmAccess.RESTRICTED,
  npmDistTag: 'latest',
  npmRegistryUrl: 'https://npm.pkg.github.com',
  npmTokenSecret: 'GITHUB_TOKEN',

  /**
   * Style
   */
  eslintOptions: {
    dirs: ['src'],
    yaml: true,
  },
  prettier: true,
  prettierOptions: {
    yaml: true,
    settings: {
      insertPragma: true,
      printWidth: 120,
      singleQuote: true,
    },
  },

  /**
   * Pull Request Formatting
   */
  githubOptions: {
    // https://projen.io/api/API.html#projen-github-pullrequestlint
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: ['build', 'chore', 'feat', 'ci', 'docs', 'style', 'refactor', 'perf', 'test', 'fix'],
      },
    },
  },
});

// JSII sets this to `false` so we need to be compatible
const tsConfigDev = project.tryFindObjectFile('tsconfig.dev.json');
tsConfigDev?.patch(JsonPatch.replace('/compilerOptions/esModuleInterop', false));

project.synth();
