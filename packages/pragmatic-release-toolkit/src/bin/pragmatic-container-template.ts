#!/usr/bin/env node
import { ContainerTemplateCli } from '../template/container-template-cli.js'

process.exitCode = ContainerTemplateCli.Run(process.argv.slice(2), {
    Out: line => console.log(line),
    Err: line => console.error(line),
})
