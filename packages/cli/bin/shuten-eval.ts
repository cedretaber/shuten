#!/usr/bin/env node
import { main } from "../src/main.ts";

const exitCode = await main(process.argv.slice(2), process.env);
process.exitCode = exitCode;
