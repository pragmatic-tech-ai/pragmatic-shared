import { PublishCli } from './publishing/publish-cli.js';

process.exitCode = PublishCli.Main(process.argv.slice(2));
