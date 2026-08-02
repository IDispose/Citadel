#!/usr/bin/env bun

'use strict';

const fs = require('fs');

const value = JSON.parse(fs.readFileSync('sample-config.json', 'utf8'));
if (value.feature !== 'operation-control' || value.enabled !== true) process.exitCode = 1;
