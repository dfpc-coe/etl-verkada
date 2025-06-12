<h1 align='center'>ETL-Verkada</h1>

<p align='center'>Pull in Verkada Camera Locations & Streams</p>

## Setup

1. Contact the administrator of the Verkada management and follow the guide [here](https://apidocs.verkada.com/reference/quick-start-guide) to create a new API Key
2. Ensure the `Cameras: Read`, & `Streaming - Live/Historical` Permissions are given for all sites.
3. Set the expiration to be as long as possible otherwise the ETL will start to fail after the API Token expires
4. Request a copy of the API Key shown to the admin after the "Generate API" button is clicked.

## Development

<details><summary>Development Information</summary>

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.

</details>

