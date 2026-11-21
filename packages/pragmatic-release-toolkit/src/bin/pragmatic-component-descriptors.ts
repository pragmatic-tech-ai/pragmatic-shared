#!/usr/bin/env node
import { ComponentDescriptorBin } from '../release/component-descriptor-bin.js'

ComponentDescriptorBin.Main(process.argv.slice(2), {
    Out: line => console.log(line),
    Err: line => console.error(line),
}).then(code => { process.exitCode = code })
