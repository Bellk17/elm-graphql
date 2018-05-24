/**
 * Copyright (c) 2016, John Hewson
 * All rights reserved.
 */

/// <reference path="../typings/node.d.ts" />
/// <reference path="../typings/request.d.ts" />
/// <reference path="../typings/graphql-utilities.d.ts" />
/// <reference path="../typings/command-line-args.d.ts" />

import 'source-map-support/register';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as request from 'request';
import * as commandLineArgs from 'command-line-args';
import { introspectionQuery, buildClientSchema } from 'graphql/utilities';
import { GraphQLSchema } from 'graphql/type';
import { queryToElm } from './query-to-elm';
import { validate } from 'graphql/validation';
import * as Lang from 'graphql/language';

// The program begins here

// TODO:
//   All of these files declare "All rights reserved." to John Hewson.
//   Could we get him to release the rights under a more permissive
//   agreement such as MIT?

// TODO:
//   This file is a mixture of inline scripting style code and functions.
//   That isn't a problem in and of itself, but the structure of the code
//   is a bit hard to follow because it randomly jumps from the scripting
//   style to the function style halfway through.
//   It would likely be easier to follow if the processFiles function
//   is extracted to be inline with the rest of the code. Or the rest
//   of the code is moved to the processFiles function (suitably renamed of course.)

// TODO:
//   This code is partially async and partially synchronous. Synchronous isn't
//   really a problem since this is a command line app, but the code should
//   probably be one or the other. See the next TODO.

// TODO:
//   Read all elm files in parallel and process them when they are available.
//   Currently one file is read and processed at a time before reading
//   the next file begins.

// TODO:
//   Make the endpoint configurable per-graphql file.
//   This could be useful because some projects have a public endpoint
//   and a separate private endpoint with authentication.

// TODO:
//   The generated modules require a GraphQL module containing some helping code.
//   It would be nice if this wasn't necessary.

// Declare the possible command line options
let options: any = commandLineArgs([
  { name: 'init', type: Boolean },
  { name: 'endpoint', type: String, defaultOption: true },
  { name: 'schema', type: String },
  { name: 'method', type: String },
  { name: 'help', type: Boolean },
  { name: 'error-spec', type: Boolean },
]);

// Print the usage information if requested
if (options.help) {
  usage();
  process.exit(1);
}

// Ensure that an endpoint was provided
// TODO: Does this make it impossible to use a schema file rather than an endpoint?
if (!options.endpoint) {
    console.error('Must specify a graphql endpoint (use option --endpoint');
    process.exit(1);
}


let verb = options.method || 'GET';
let endpointUrl = options.endpoint;
let errorSpec = options['error-spec'];


// Parse the graphql schema from a file
if (options.schema) {
    const filepath = path.resolve(options.schema);
    const obj = require(filepath);
    let schema = buildClientSchema(obj.data)
    processFiles(schema, errorSpec);
}


// Generate the graphql schema from a live endpoint
else {
    performIntrospectionQuery(body => {
        let result = JSON.parse(body);
        let schema = buildClientSchema(result.data);
        processFiles(schema, errorSpec);
    });
}


// Generate a schema by querying a GraphQL endpoint
// TODO: Convert this to a promise. On the other hand, there's not really anything wrong with the callback.
function performIntrospectionQuery(callback: (body: string) => void) {
  let introspectionUrl = options.endpoint;

  if (!introspectionUrl) {
    // TODO: Does this tool use elm-package.json anymore?
    console.log('Error: missing graphql endpoint in elm-package.json');
    process.exit(1);
  }

  // Create the GET or POST request.
  // TODO: Determine if POST actually works. I couldn't get it to.
  let reqOpts = verb == 'GET'
    ? { url: introspectionUrl,
        verb,
        qs: {
          query: introspectionQuery.replace(/\n/g, '').replace(/\s+/g, ' ')
        }
      }
    : { url: introspectionUrl,
        verb,
        headers: [{ 'Content-Type': 'application/json' }],
        body: JSON.stringify({ query: introspectionQuery })
      };

  request(reqOpts, function (err, res, body) {
    if (err) {
      throw new Error(err);
    } else if (res.statusCode == 200) {
      callback(body);
    } else {
      console.error('Error', res.statusCode, '-', res.statusMessage);
      console.error('\n', res.headers);
      console.error('\n', body.trim());
      console.error('\nThe GraphQL server at ' + introspectionUrl + ' responded with an error.');
      process.exit(1);
    }
  });
}


// Capitalize the first letter of the provided string
function capitalize(str: string): string {
    return str[0].toUpperCase() + str.substr(1);
}


// Read .graphql files from disk and generate Elm modules which
// perform the indicated queries.
// TODO: This function actually does alot. May want to split out the directory scanning part.
function processFiles(schema: GraphQLSchema, errorSpec: boolean) {
  // Get the list of .graphql files in this and all sub-directories
  let paths = scanDir('.', []);

  // Loop over each .graphql file generating the Elm module for it and writing it to disk
  for (let filePath of paths) {
    let fullpath = path.join(...filePath);
    let graphql = fs.readFileSync(fullpath, 'utf8');
    let doc = Lang.parse(graphql)
    let errors = validate(schema, doc)

    if (errors.length) {
      console.error('Error processing ' + fullpath + ': ')
      for (let err of errors) {
        console.error(' -' + err.message);
      }
      process.exit(1)
    }

    // TODO: Remove the requirement of a "src/" directory or make it configurable
    // This group of declarations computes the .elm output file names and module names
    let rootindex = fullpath.indexOf("src/");
    let rootpath = fullpath.substr(rootindex + 4);
    let pathdirs = rootpath.split('/');
    let filepath = pathdirs.map(capitalize).join('.');
    let basename = path.basename(fullpath);
    let extname =  path.extname(fullpath);
    let filename = basename.substr(0, basename.length - extname.length);
    let moduleName = filepath.substr(0, filepath.length - extname.length);
    let outPath = path.join(path.dirname(fullpath), filename + '.elm');

    // Compile the GraphQL File to Elm
    let elm = queryToElm(graphql, moduleName, endpointUrl, verb, schema, errorSpec);
    fs.writeFileSync(outPath, elm);

    // Format the code if elm-format is available
    // TODO: Only perform this attempt one time. Spinning up another process is costly.
    // TODO: Can it be done asynchronously?
    try {
      child_process.execSync('elm-format "' + outPath + '" --yes');
    } catch (e) {
      // ignore
    }
  }

  // Let the user know everything succeeded!
  let plural = paths.length != 1 ? 's' : '';
  console.log('Success! Generated ' + paths.length + ' module' + plural + '.')
}


// Recursively scan the provided directory and return a list of .graphql files
// The parts parameter is used as part of the recursive state-keeping, so always
// pass an empty array to it.
function scanDir(dirpath: string, parts: Array<string>): Array<Array<string>> {
  // TODO: Would this be simplier using higher-order list functions?
  let filenames = fs.readdirSync(dirpath);
  let found: Array<Array<string>> = [];

  for (let filename of filenames) {
    if (filename === 'node_modules') {
      continue;
    }

    let fullPath = path.join(dirpath, filename);

    if (fs.statSync(fullPath).isDirectory() && filename[0] != '.') {
      found = found.concat(scanDir(fullPath, parts.concat([filename])));
    } else {
      if (path.extname(filename) == '.graphql') {
        found.push(parts.concat(filename));
      }
    }
  }

  return found;
}


// Print the usage of the CLI tool
// TODO: This is incomplete
function usage() {
  let version  = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
  console.error('elm-graphql ' + version);
  console.error();
  console.error('Usage: elm graphql --init ENDPOINT-URL');
  console.error(' ');
  console.error('Available options:');
  console.error('  --schema filepath            relative path to schema file (JSON).');
}
