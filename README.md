# demo-stack-proxy

Our serverless [proxy stack](https://github.com/KlickMarketing/demo-stack-proxy) which is used to dynamically deploy N number of serverless environments as organized subdomains.

## Installation

`yarn install`

## Configuration

There are a few things needing to be setup first. Anything with `ssm:` in front means it needs to be setup as an [SSM param](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-paramstore.html) under the same account you will be running this demo under:

- `ssm:demo-stack-proxy-ghwebhooksecret`: Once you have deployed this stack once, you will need to copy the githubwebhook url from outputs and setup the [webhook in GitHub](https://github.com/KlickMarketing/demo-site/settings/hooks). This should be done on your fork of our [demo-site](https://github.com/KlickMarketing/demo-site)  repo. Create a secret to set for the webhook and also ensure the value is placed in this SSM param.
- `ssm:demo-github-token`: [GitHub Access Token](https://github.com/settings/tokens) that needs to be setup on the account that has access to the above forked repo.
- `CI_ROLE_ARN`: IAM role that needs to be setup in AWS. The role will need admin access. This role is used to automate deleting CloudFormation Stacks.

## Deployment

`sls deploy -s dev`


## Usage Agreement

All code provided in these examples is given with no warrenty and should be used at your own discresion and risk. Klick assumes no liablity for this code, or any fees/costs associated with it's use.