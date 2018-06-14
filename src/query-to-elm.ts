/**
 * Copyright (c) 2016, John Hewson
 * All rights reserved.
 */

/// <reference path="../typings/node.d.ts" />
/// <reference path="../typings/es6-function.d.ts" />
/// <reference path="../typings/graphql-types.d.ts" />
/// <reference path="../typings/graphql-language.d.ts" />
/// <reference path="../typings/graphql-utilities.d.ts" />

import {
  Definition,
  OperationDefinition,
  FragmentDefinition,
  FragmentSpread,
  InlineFragment,
  SelectionSet,
  Field,
  Document,
  Type,
  parse,
  print,
  visit
} from "graphql/language";

import {
  ElmFieldDecl,
  ElmDecl,
  ElmTypeDecl,
  ElmParameterDecl,
  moduleToString,
  fileToString,
  ElmModuleDecl,
  ElmImportDecl,
  ElmExpr,
  ElmFunctionDecl,
  ElmType,
  ElmTypeName,
  ElmTypeRecord,
  ElmTypeApp,
  ElmTypeAliasDecl
} from './elm-ast';

import {
  GraphQLSchema,
  GraphQLNonNull,
  GraphQLList,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLInputObjectType,
  GraphQLUnionType
} from 'graphql/type';

import {
  TypeInfo,
  typeFromAST,
} from 'graphql/utilities';

import {
  decoderForQuery,
  decoderForFragment
} from './query-to-decoder';

// TODO:
//   The logic in this module is a bit weird. What it probably ought to be doing
//   is walking over the query and extracting all of the enums, fragments, and unions
//   that are actually used and generating Elm for them. Then generating Elm for
//   the actual query itself. Instead it's mixing the generation all up in a knot.

// TODO:
//   In generating module and type names the "capitalize first character" operation
//   is used often. There should be an easy function for this as the code to do
//   it is repeated in many places.

// Notes to future readers:
// * We use Elm's JSON encoder to generate the request document, but not the query text itself since that isn't valid JSON
//   This includes the wrapper around the query and the list of parameters if they are needed
// * The info parameter that's passed to basically every function is a stateful object which tracks
//   a "current location" in the GraphQL schema. It is used to validate typing of the query
// * The GraphQL module provided by Facebook has a number of super useful things that are used here
//   including an AST, parser, and printer (converts an AST to a string)

// TODO: Document why these are here
export type GraphQLEnumMap = { [name: string]: GraphQLEnumType };
export type GraphQLTypeMap = { [name: string]: GraphQLType };
export type FragmentDefinitionMap = { [name: string]: FragmentDefinition };
export type GraphQLUnionMap = { [name: string]: GraphQLUnionType };

// TODO: Document what this is for
const alphabet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
                  'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];

// Compile the provided GraphQL code to an Elm module, type checking it against the provided GraphQL Schema
export function queryToElm(
  graphql: string,       // GraphQL query to parse and generate
  moduleName: string,    // Name for the Elm module being generated
  liveUrl: string,       // The endpoint URL (so the generated Elm knows where to query)
  verb: string,          // HTTP Verb to send a request to the server using
  schema: GraphQLSchema  // GraphQL Schema to typecheck against
): string {
  // Parse the GraphQL query into a GraphQL AST
  let queryDocument = parse(graphql);

  let [decls, expose] = translateQuery(liveUrl, queryDocument, schema, verb);

  let importGraphql: ElmImportDecl = new ElmImportDecl("GraphQL", null, ["apply", "maybeEncode", "query", "mutation"]);

  return fileToString(
    new ElmModuleDecl(moduleName, expose),
    [
      new ElmImportDecl("Json.Decode", null, [".."]),
      new ElmImportDecl("Json.Encode", null, ["encode"]),
      new ElmImportDecl("Http"),
      importGraphql
    ],
    decls
  );
}


// Convert the provided GraphQL Document AST into a list of Elm declarations and functions/types that need to be exposed
// TODO: Convert the Array<string> output from this function into an ElmModule AST type (which doesn't exist yet)
function translateQuery(
  uri: string,
  doc: Document,
  schema: GraphQLSchema,
  verb: string
): [Array<ElmDecl>, Array<string>] {
  // List of the functions/types that need to be exposed by this module
  let expose: Array<string> = [];

  // Collection of the fragments defined in this document to be referenced when creating the types/decoders
  // for queries spreading the fragments
  let fragmentDefinitionMap: FragmentDefinitionMap = {};

  // Convert the given query document into a list of Elm declarations and things for the module to expose
  function walkQueryDocument(doc: Document, info: TypeInfo): [Array<ElmDecl>, Array<string>] {
    // List of top declarations that need to be created
    let decls: Array<ElmDecl> = [];
    // Add a variable for the endpoint URL so requests know where to be sent to
    decls.push(new ElmFunctionDecl('endpointUrl', [], new ElmTypeName('String'), { expr: `"${uri}"` }));

    // Get all of the fragments defined in this document
    buildFragmentDefinitionMap(doc);

    // These keep track of the fragments, enums, and unions that have actually been seen
    // so that they are only output if actually used.
    let seenFragments: FragmentDefinitionMap = {};
    let seenEnums: GraphQLEnumMap = {};
    let seenUnions: GraphQLUnionMap = {};

    // Iterate over every definition in the document pushing their compiled Elm onto the result list
    for (let def of doc.definitions) {
      if (def.kind == 'OperationDefinition') {
        decls.push(...walkOperationDefinition(<OperationDefinition>def, info));
      } else if (def.kind == 'FragmentDefinition') {
        decls.push(...walkFragmentDefinition(<FragmentDefinition>def, info));
      }

      collectFragments(def, seenFragments);
      collectEnums(def, seenEnums);
      collectUnions(def, seenUnions);
    }

    // Iterate over each fragment, enum and union that has been seen outputting the relevant Elm
    for (let fragName in seenFragments) {
      let frag = seenFragments[fragName];
      let decodeFragFuncName = fragName[0].toLowerCase() + fragName.substr(1) + 'Decoder';
      let fragTypeName = fragName[0].toUpperCase() + fragName.substr(1);
      let fragTypeNameExt = fragTypeName + '_';
      // TODO: Output a decoder for fragments rather than expanding it again and again each time it is used
      expose.push(fragTypeName);
      expose.push(fragTypeNameExt);
    }

    for (let name in seenEnums) {
      let seenEnum = seenEnums[name];
      decls.unshift(walkEnum(seenEnum));
      decls.push(decoderForEnum(seenEnum));
      expose.push(seenEnum.name+'(..)');
    }

    for (let name in seenUnions) {
      let union = seenUnions[name];
      decls = walkUnion(union, info).concat(decls);
      expose.push(name+'(..)');
    }

    return [decls, expose];
  }

  // Pull the fragment definitions out of the provided document and put them into the fragment map
  function buildFragmentDefinitionMap(doc: Document): void {
    // Visit every node in the AST, checking if they are a fragment and adding them to the map if so
    visit(doc, {
      enter: function(node) {
        if (node.kind == 'FragmentDefinition') {
          let def = <FragmentDefinition>node;
          let name = def.name.value;
          fragmentDefinitionMap[name] = def;
        }
      },
      leave: function(node) {}
    });
  }

  // Add a fragment from the list of document fragments to the provided map
  function collectFragments(def: Definition, fragments: FragmentDefinitionMap = {}): FragmentDefinitionMap {
    visit(doc, {
      enter: function(node) {
        if (node.kind == 'FragmentSpread') {
          let spread = <FragmentSpread>node;
          let name = spread.name.value;
          fragments[name] = fragmentDefinitionMap[name];
        }
      },
      leave: function(node) {}
    });
    return fragments;
  }

  // Retrieve fragments used in the specified query definition selection set
  function queryFragments(selectionSet: SelectionSet, fragments: FragmentDefinitionMap = {}): FragmentDefinitionMap {
    if (selectionSet) {
        visit(selectionSet, {
            enter: function (node) {
                if (node.kind == 'FragmentSpread') {
                    let spread = <FragmentSpread>node;
                    let name = spread.name.value;
                    let frag = fragments[name] = fragmentDefinitionMap[name];
                    fragments = queryFragments(frag.selectionSet, fragments);
                }
            },
            leave: function (node) {
            }
        });
    }
    return fragments;
  }

  // Add a union from the document to the provided union map
  // TODO: Why does this take a Definition?
  function collectUnions(def: Definition, unions: GraphQLUnionMap = {}): GraphQLUnionMap {
    let info = new TypeInfo(schema);
    visit(doc, {
      enter: function(node, key, parent) {
        let parentType: any = info.getType();
        if (parentType instanceof GraphQLNonNull) {
          parentType = parentType['ofType']
        }
        if (parentType instanceof GraphQLList) {
          parentType = parentType['ofType']
        }
        if (parentType instanceof GraphQLNonNull) {
            parentType = parentType['ofType']
        }
        if (parentType instanceof GraphQLUnionType) {
          unions[parentType.name] = parentType;
        }
        info.enter(node);
      },
      leave: function(node) {
        info.leave(node);
      }
    });
    return unions;
  }

  // Add an enum from the document to the provided enum map
  function collectEnums(def: Definition, enums: GraphQLEnumMap = {}): GraphQLEnumMap {
    let info = new TypeInfo(schema);
    visit(doc, {
      enter: function(node, key, parent) {
        info.enter(node);
        if (node.kind == 'Field') {
          let field = <Field>node;
          let name = field.name.value;
          let type = info.getType();
          collectEnumsForType(type, enums);
        }
        // TODO: do we need to walk into fragment spreads?
      },
      leave: function(node, key, parent) {
        info.leave(node);
      }
    });
    return enums;
  }

  // 
  function collectEnumsForType(type: GraphQLType, seen: GraphQLEnumMap = {}, seenTypes: GraphQLTypeMap = {}): void {
    if (type instanceof GraphQLEnumType) {
      seen[type.name] = type;
    } else if (type instanceof GraphQLList) {
      collectEnumsForType(type.ofType, seen, seenTypes);
    } else if (
      type instanceof GraphQLObjectType
      || type instanceof GraphQLInterfaceType
      || type instanceof GraphQLInputObjectType
    ) {
      if (seenTypes[type.name]) {
        return;
      } else {
        seenTypes[type.name] = type;
      }

      let fieldMap = type.getFields();
      for (let fieldName in fieldMap) {
        let field = fieldMap[fieldName];
        collectEnumsForType(field.type, seen, seenTypes)
      }
    } else if (type instanceof GraphQLNonNull) {
      collectEnumsForType(type.ofType, seen, seenTypes);
    }
  }


  function walkEnum(enumType: GraphQLEnumType): ElmTypeDecl {
    return new ElmTypeDecl(
      enumType.name,
      enumType.getValues()
        .map(v => enumType.name + '_' + v.name[0].toUpperCase() + v.name.substr(1).toLowerCase()));
  }


  function decoderForEnum(enumType: GraphQLEnumType): ElmFunctionDecl {
    // might need to be Maybe Episode, with None -> fail in the Decoder
    let decoderTypeName = enumType.name[0].toUpperCase() + enumType.name.substr(1);
    return new ElmFunctionDecl(
        enumType.name.toLowerCase() + 'Decoder',
        [],
        new ElmTypeName('Decoder ' + decoderTypeName),
        { expr: 'string |> andThen (\\s ->\n' +
          '        case s of\n' + enumType.getValues().map(v =>
          '            "' + v.name + '" -> succeed ' + decoderTypeName + '_' + v.name[0].toUpperCase() + v.name.substr(1).toLowerCase()).join('\n') + '\n' +
          '            _ -> fail "Unknown ' + enumType.name + '")'
        });
  }


  function walkUnion(union: GraphQLUnionType, info: TypeInfo): Array<ElmDecl> {
    if (union instanceof GraphQLNonNull) {
      union = <GraphQLUnionType> union['ofType'];
    }
    if (union instanceof GraphQLList) {
        union = <GraphQLUnionType> union['ofType']
    }
    let types = union.getTypes();
    let params = types.map((t, i) => alphabet[i]).join(' ');
    let decls: Array<ElmDecl> = [];
    decls.push(new ElmTypeDecl(union.name + ' ' + params, types.map((t, i) => elmSafeName(union.name+'_'+t.name) + ' ' + alphabet[i])));
    return decls;
  }


  // TODO: This code seems very similar to the walkOperation function
  // in query-to-decoder. Is there something useful to abstract?
  function walkOperationDefinition(def: OperationDefinition, info: TypeInfo): Array<ElmDecl> {
    info.enter(def);

    if (!info.getType()) {
      throw new Error(`GraphQL schema does not define ${def.operation} '${def.name.value}'`);
    }

    if (def.operation == 'query' || def.operation == 'mutation') {
      let decls: Array<ElmDecl> = [];

      let name: string;
      if (def.name) {
        name = def.name.value;
      } else {
        name = 'AnonymousQuery';
      }
      let resultType = name[0].toUpperCase() + name.substr(1);
      let responseType = resultType;

      // TODO: Directives

      let [fields, spreads] = walkSelectionSet(def.selectionSet, info);

      // TODO: use spreads...

      decls.push(new ElmTypeAliasDecl(resultType, new ElmTypeRecord(fields)))

      let parameters: Array<{name: string, type: ElmType, schemaType: GraphQLType, hasDefault:boolean}> = [];
      if (def.variableDefinitions) {
        for (let varDef of def.variableDefinitions) {
          let name = varDef.variable.name.value;
          let schemaType = typeFromAST(schema, varDef.type);
          let type = typeToElm(schemaType);
          parameters.push({ name, type, schemaType, hasDefault: varDef.defaultValue != null });
        }
      }
      let funcName = name[0].toLowerCase() + name.substr(1);

      // grabs all fragments
      let seenFragments = collectFragments(def);

      // grabs all fragment dependencies in the query
      let qFragments = queryFragments(def.selectionSet);

      // Generate the string that will actually be output
      let query = '';
      for (let name in qFragments) {
        query += print(qFragments[name]) + ' ';
      }

      query += print(def);
      let decodeFuncName = resultType[0].toLowerCase() + resultType.substr(1) + 'Decoder';
      expose.push(funcName);
      expose.push(resultType);

      let elmParamsType = new ElmTypeRecord(parameters.map(p => new ElmFieldDecl(p.name, p.type)));
      let elmParams = new ElmParameterDecl('params', elmParamsType);
      let elmParamsDecl = elmParamsType.fields.length > 0 ? [elmParams] : [];
      let methodParam = def.operation == 'query' ? `"${verb}" ` : '';

      decls.push(new ElmFunctionDecl(
         funcName, elmParamsDecl, new ElmTypeName(`Http.Request ${responseType}`),
         {
           // we use awkward variable names to avoid naming collisions with query parameters
           expr: `let graphQLQuery = """${query.replace(/\s+/g, ' ')}""" in\n` +
             `    let graphQLParams =\n` +
             `            Json.Encode.object\n` +
             `                [ ` +
             parameters.map(p => {
              let encoder: string;
               if (p.hasDefault) {
                 encoder =`case params.${p.name} of` +
                     `\n                            Just val -> ${encoderForInputType(p.schemaType, true)} val` +
                     `\n                            Nothing -> Json.Encode.null`
               } else {
                 encoder = encoderForInputType(p.schemaType, true, 'params.' + p.name);
               }
               return `("${p.name}", ${encoder})`;
             })
             .join(`\n                , `) + '\n' +
             `                ]\n` +
             `    in\n` +
             `    ${def.operation} ${methodParam}endpointUrl graphQLQuery "${name}" graphQLParams ${decodeFuncName}`
         }
      ));
      let resultTypeName = resultType[0].toUpperCase() + resultType.substr(1);
      decls.push(new ElmFunctionDecl(
         decodeFuncName, [],
         new ElmTypeName('Decoder ' + resultTypeName),
         decoderForQuery(def, info, schema, fragmentDefinitionMap, seenFragments) ));

      info.leave(def);
      return decls;
    }
  }


  function encoderForInputType(type: GraphQLType, isNonNull?: boolean, path?: string): string {
    let encoder: string;

    let value = path;
    let isMaybe = false
    if (type instanceof GraphQLNonNull) {
      type = type['ofType'];
    } else {
      isMaybe = true;
      value = 'o';
    }

    if (type instanceof GraphQLInputObjectType) {
      let fieldEncoders: Array<string> = [];
      let fields = type.getFields();
      for (let name in fields) {
        let field = fields[name];
        let valuePath = value + '.' + field.name;
        fieldEncoders.push(`("${field.name}", ${encoderForInputType(field.type, false, valuePath)})`);
      }
      encoder = '(Json.Encode.object [' + fieldEncoders.join(`, `) + '])';
    } else if (type instanceof GraphQLList) {
      encoder = '(Json.Encode.list (List.map (\\x -> ' + encoderForInputType(type.ofType, true, 'x') + ') ' + value + '))';
    } else if (type instanceof GraphQLScalarType) {
      switch (type.name) {
        case 'Int': encoder = 'Json.Encode.int ' + value; break;
        case 'Float': encoder = 'Json.Encode.float ' + value; break;
        case 'Boolean': encoder = 'Json.Encode.bool ' + value; break;
        case 'ID':
        case 'DateTime': encoder = 'Json.Encode.string ' + value; break;
        case 'String': encoder = 'Json.Encode.string ' + value; break;
        default: encoder = 'Json.Encode.string ' + value; break;
      }
    } else if (type instanceof  GraphQLEnumType) {
      const name = type.name;
      const values = type.getValues()
      const tuples = values.map((v) => `("${name + '_' + v.name[0].toUpperCase() + v.name.substr(1).toLowerCase()}", "${v.name}")`)
      const map = `[${tuples.join(',')}]`
      encoder = `Json.Encode.string <| Maybe.withDefault "" <| Maybe.map Tuple.second <| List.head <| (\\s -> List.filter (Tuple.first >> (==)(s)) ${map} ) <| toString ` + value;
    } else {
      throw new Error('not implemented: ' + type.constructor.name);
    }

    if (isMaybe) {
      encoder = '(maybeEncode (\\o -> ' + encoder + ') '+ path + ')'
    }
    return encoder;
  }

  function walkFragmentDefinition(def: FragmentDefinition, info: TypeInfo): Array<ElmDecl> {
    info.enter(def);

    let name = def.name.value;

    let decls: Array<ElmDecl> = [];
    let resultType = name[0].toUpperCase() + name.substr(1);

    // todo: Directives

    // SelectionSet
    let [fields, spreads] = walkSelectionSet(def.selectionSet, info);

    let type: ElmType = new ElmTypeRecord(fields, 'a')
    for (let spreadName of spreads) {
      let typeName = spreadName[0].toUpperCase() + spreadName.substr(1) + '_';
      type = new ElmTypeApp(typeName, [type]);
    }
    
    
    decls.push(new ElmTypeAliasDecl(resultType + '_', type, ['a']));
    decls.push(new ElmTypeAliasDecl(resultType, new ElmTypeApp(resultType + '_', [new ElmTypeRecord([])])));

    info.leave(def);
    return decls;
  }

  function walkSelectionSet(selSet: SelectionSet, info: TypeInfo): [Array<ElmFieldDecl>, Array<string>, ElmType] {
    info.enter(selSet);
    let fields: Array<ElmFieldDecl> = [];
    let spreads: Array<string> = [];
    let info_type: any = info.getType();

    if (info_type instanceof GraphQLNonNull) {
        info_type = info_type['ofType'];
    }

    if (info_type instanceof GraphQLList) {
        info_type = info_type['ofType'];
    }

    if (info_type instanceof GraphQLNonNull) {
        info_type = info_type['ofType'];
    }

    if (info_type instanceof GraphQLUnionType) {
      let type = walkUnionSelectionSet(selSet, info);
      info.leave(selSet);
      return [[], [], type];
    } else {
      for (let sel of selSet.selections) {
        if (sel.kind == 'Field') {
          let field = <Field>sel;
          fields.push(walkField(field, info));
        } else if (sel.kind == 'FragmentSpread') {
          spreads.push((<FragmentSpread>sel).name.value);
        } else if (sel.kind == 'InlineFragment') {
          let frag = (<InlineFragment>sel);
          // todo: InlineFragment
          throw new Error('not implemented: InlineFragment on ' + frag.typeCondition.name.value);
        }
      }

      info.leave(selSet);
      return [fields, spreads, null];
    }
  }
  
  function walkUnionSelectionSet(selSet: SelectionSet, info: TypeInfo): ElmType {
    let union: any = <GraphQLUnionType>info.getType();
    let hasTypename = false;

      if (union instanceof GraphQLNonNull) {
          union = union['ofType']
      }

      if (union instanceof GraphQLList) {
          union = union['ofType']
      }

      if (union instanceof GraphQLNonNull) {
          union = union['ofType']
      }

      let typeMap: { [name: string]: ElmType } = {};

      for (let sel of selSet.selections) {
        if (sel.kind == 'Field') {
          let field = (<Field>sel)
          if (field.name.value == "__typename") {
            hasTypename = true;
          }
        }
        if (sel.kind == 'InlineFragment') {
          let inline = (<InlineFragment>sel);

          info.enter(inline);
          let [fields, spreads] = walkSelectionSet(inline.selectionSet, info);
          info.leave(inline);

          // record
          let type: ElmType = new ElmTypeRecord(fields);
          // spreads
          for (let spreadName of spreads) {
            let typeName = spreadName[0].toUpperCase() + spreadName.substr(1) + '_';
            type = new ElmTypeApp(typeName, [type]);
          }

          typeMap[inline.typeCondition.name.value] = type;
        }
        else if (sel.kind == 'FragmentSpread') {
          let spread = (<FragmentSpread>sel);
          let name = spread.name.value;
          let frag = fragmentDefinitionMap[name];

          info.enter(frag);
          let [fields, spreads] = walkSelectionSet(frag.selectionSet, info);
          info.leave(frag);

          // record
          let type: ElmType = new ElmTypeRecord(fields);
          // spreads
          for (let spreadName of spreads) {
              let typeName = spreadName[0].toUpperCase() + spreadName.substr(1) + '_';
              type = new ElmTypeApp(typeName, [type]);
          }

          typeMap[spread.name.value] = type;
        }
      }

      if (!hasTypename) {
        throw new Error(`must query field '__typename' on union types (missing for '${union.name}')`);
      }

      let args: Array<ElmType> = [];
      for (let name in typeMap) {
        args.push(typeMap[name]);
      }

      return new ElmTypeApp(union.name, args);
  }

  function walkField(field: Field, info: TypeInfo): ElmFieldDecl {
    info.enter(field);

    let info_type: any = info.getType()
    // Name
    let name = elmSafeName(field.name.value);
    // Alias
    if (field.alias) {
      name = elmSafeName(field.alias.value);
    }
    // todo: Arguments, such as `id: $someId`, where $someId is a variable
    let args = field.arguments; // e.g. id: "1000"
    // todo: Directives
    // SelectionSet
    if (field.selectionSet) {
      let isMaybe = false
      if (info_type instanceof GraphQLNonNull) {
        info_type = info_type['ofType'];
      } else {
        isMaybe = true
      }

      let isList = info_type instanceof GraphQLList;

      let [fields, spreads, union] = walkSelectionSet(field.selectionSet, info);
      
      let type: ElmType = union ? union : new ElmTypeRecord(fields);

      for (let spreadName of spreads) {
        let typeName = spreadName[0].toUpperCase() + spreadName.substr(1) + '_';
        type = new ElmTypeApp(typeName, [type]);
      }

      if (isList) {
        type = new ElmTypeApp('List', [type]);
      }

      if (isMaybe) {
	    type = new ElmTypeApp('Maybe', [type]);
      }

      info.leave(field);
      return new ElmFieldDecl(name, type)
    } else {
      if (!info.getType()) {
        throw new Error('Unknown GraphQL field: ' + field.name.value);
      }
      let type = typeToElm(info.getType());
      info.leave(field);
      return new ElmFieldDecl(name, type)
    }
  }

  return walkQueryDocument(doc, new TypeInfo(schema));
}

export function typeToElm(type: GraphQLType, isNonNull = false): ElmType {
  let elmType: ElmType;

  if (type instanceof GraphQLNonNull) {
    elmType = typeToElm(type.ofType, true);
  }

  else if (type instanceof GraphQLScalarType) {
    switch (type.name) {
      case 'Int': elmType = new ElmTypeName('Int'); break;
      case 'Float': elmType = new ElmTypeName('Float'); break;
      case 'Boolean': elmType = new ElmTypeName('Bool'); break;
      case 'ID':
      case 'DateTime': elmType = new ElmTypeName('String'); break;
      case 'String': elmType = new ElmTypeName('String'); break;
      default: elmType = new ElmTypeName('String'); break;
    }
  } else if (type instanceof GraphQLEnumType) {
    elmType = new ElmTypeName(type.name[0].toUpperCase() + type.name.substr(1));
  } else if (type instanceof GraphQLList) {
    elmType = new ElmTypeApp('List', [typeToElm(type.ofType, true)]);
  } else if (type instanceof GraphQLObjectType ||
             type instanceof GraphQLInterfaceType ||
             type instanceof GraphQLInputObjectType) {
    let fields: Array<ElmFieldDecl> = [];
    let fieldMap = type.getFields();
    for (let fieldName in fieldMap) {
      let field = fieldMap[fieldName];
      fields.push(new ElmFieldDecl(elmSafeName(fieldName), typeToElm(field.type)))
    }
    elmType = new ElmTypeRecord(fields);
  } else {
    throw new Error('Unexpected: ' + type.constructor.name);
  }

  if (!isNonNull && !(type instanceof GraphQLList) && !(type instanceof GraphQLNonNull)) {
    elmType = new ElmTypeApp('Maybe', [elmType]);
  }
  return elmType;
}


// Convert the provided GraphQL safe name to an Elm safe name
// The GraphQL Spec allows names that Elm either doesn't support or the coding
// standard frowns upon.
// TODO: Document why Task, List, Http, and GraphQL are converted.
// TODO: Extract this to a utilities file since it is used both here and query-to-decoder.ts
export function elmSafeName(graphQlName: string): string {
  switch (graphQlName) {
    case '__typename': return 'typename_';
    case 'type': return "type_";
    case 'Task': return "Task_";
    case 'List': return "List_";
    case 'Http': return "Http_";
    case 'GraphQL': return "GraphQL_";
    // TODO: more...
    default: return graphQlName;
  }
}
