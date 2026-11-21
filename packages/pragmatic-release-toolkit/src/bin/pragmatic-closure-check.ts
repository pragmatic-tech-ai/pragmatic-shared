#!/usr/bin/env node
import { ClosureCheck } from '../closure/closure-check.js'

process.exitCode = ClosureCheck.Main(process.argv.slice(2))
