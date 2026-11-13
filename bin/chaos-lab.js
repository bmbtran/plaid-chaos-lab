#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so adapter modules can be written in TypeScript.
import { register } from 'tsx/esm/api';

register();
process.env.CHAOS_LAB_BIN = '1';
await import('../src/cli.ts');
