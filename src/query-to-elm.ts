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

export type GraphQLEnumMap = { [name: string]: GraphQLEnumType };
export type GraphQLTypeMap = { [name: string]: GraphQLType };
export type FragmentDefinitionMap = { [name: string]: FragmentDefinition };
export type GraphQLUnionMap = { [name: string]: GraphQLUnionType };

const alphabet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
                  'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];

export function queryToElm(graphql: string, moduleName: string, liveUrl: string, verb: string,
                           schema: GraphQLSchema, errorSpec: boolean): string {
  let queryDocument = parse(graphql);
  let [decls, expose] = translateQuery(liveUrl, queryDocument, schema, verb, errorSpec);
  let importGraphql = 'GraphQL exposing (apply, maybeEncode, query, mutation)';
  if (errorSpec) {
    importGraphql = 'GraphQLSpec exposing (Response, apply, maybeEncode, query, mutation)';
  }

  return moduleToString(moduleName, expose, [
    'Json.Decode exposing (..)',
    'Json.Encode exposing (encode)',
    'Time',
    'Http',
    'Maybe',
    importGraphql
  ], decls);
}

function translateQuery(uri: string, doc: Document, schema: GraphQLSchema, verb: string, errorSpec: boolean): [Array<ElmDecl>, Array<string>] {
  let expose: Array<string> = [];
  let fragmentDefinitionMap: FragmentDefinitionMap = {};

  function walkQueryDocument(doc: Document, info: TypeInfo): [Array<ElmDecl>, Array<string>] {
    let decls: Array<ElmDecl> = [];
    decls.push(new ElmFunctionDecl('endpointUrl', [], new ElmTypeName('String'), { expr: `"${uri}"` }));

    buildFragmentDefinitionMap(doc);
    let seenFragments: FragmentDefinitionMap = {};
    let seenEnums: GraphQLEnumMap = {};
    let seenUnions: GraphQLUnionMap = {};

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

    for (let fragName in seenFragments) {
      let frag = seenFragments[fragName];
      let decodeFragFuncName = fragName[0].toLowerCase() + fragName.substr(1) + 'Decoder';
      let fragTypeName = fragName[0].toUpperCase() + fragName.substr(1);
      let fragTypeNameExt = fragTypeName + '_';
      //// Outputs decoders for individual fragments (Not currently used)
      // decls.push(new ElmFunctionDecl(
      //         decodeFragFuncName, [],
      //         new ElmTypeName('Decoder ' + fragTypeName),
      //         decoderForFragment(frag, info, schema, fragmentDefinitionMap, seenFragments) ));
      // expose.push(decodeFragFuncName);
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

  function buildFragmentDefinitionMap(doc: Document): void {
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
  
  function collectUnions(def: Definition, unions: GraphQLUnionMap = {}): GraphQLUnionMap {
    let info = new TypeInfo(schema);
    visit(doc, {
      enter: function(node, key, parent) {
        let parentType = <GraphQLUnionType> info.getType();
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

  function collectEnums(def: Definition, enums: GraphQLEnumMap = {}): GraphQLEnumMap {

    // Scan operation variables for enums.
    if(def.kind == 'OperationDefinition') {
      let operationDef = <OperationDefinition> def;
      if (operationDef.variableDefinitions) {
          for (let varDef of operationDef.variableDefinitions) {
              let schemaType = typeFromAST(schema, varDef.type);
              collectEnumsForType(schemaType, enums);
          }
      }
    }

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
        // todo: do we need to walk into fragment spreads?
      },
      leave: function(node, key, parent) {
        info.leave(node);
      }
    });
    return enums;
  }

  function collectEnumsForType(type: GraphQLType, seen: GraphQLEnumMap = {}, seenTypes: GraphQLTypeMap = {}): void {
    if (type instanceof GraphQLEnumType) {
      seen[type.name] = type;
    } else if (type instanceof GraphQLList) {
      collectEnumsForType(type.ofType, seen, seenTypes);
    } else if (type instanceof GraphQLObjectType ||
               type instanceof GraphQLInterfaceType ||
               type instanceof GraphQLInputObjectType) {
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
    return new ElmTypeDecl(enumType.name, enumType.getValues().map(v => enumType.name + '_' + v.name[0].toUpperCase() + v.name.substr(1).toLowerCase()));
  }

  function decoderForEnum(enumType: GraphQLEnumType): ElmFunctionDecl {
    // might need to be Maybe Episode, with None -> fail in the Decoder
    let decoderTypeName = enumType.name[0].toUpperCase() + enumType.name.substr(1);
    return new ElmFunctionDecl(enumType.name.toLowerCase() + 'Decoder', [], new ElmTypeName('Decoder ' + decoderTypeName),
        { expr: 'string |> andThen (\\s ->\n' +
                '        case s of\n' + enumType.getValues().map(v =>
                '            "' + v.name + '" -> succeed ' + decoderTypeName + '_' + v.name[0].toUpperCase() + v.name.substr(1).toLowerCase()).join('\n') + '\n' +
                '            _ -> fail "Unknown ' + enumType.name + '")'
              });
  }

  function walkUnion(union: GraphQLUnionType, info: TypeInfo): Array<ElmDecl> {
    if (union instanceof GraphQLNonNull) {
      union = union['ofType'];
    }
    if (union instanceof GraphQLList) {
        union = union['ofType']
    }
    let types = union.getTypes();
    let params = types.map((t, i) => alphabet[i]).join(' ');
    let decls: Array<ElmDecl> = [];
    decls.push(new ElmTypeDecl(union.name + ' ' + params, types.map((t, i) => elmSafeName(union.name+'_'+t.name) + ' ' + alphabet[i])));
    return decls;
  }
  
  function walkOperationDefinition(def: OperationDefinition, info: TypeInfo): Array<ElmDecl> {
    info.enter(def);
    if (!info.getType()) {
      throw new Error(`GraphQL schema does not define ${def.operation} '${def.name.value}'`);
    }
    if (def.operation == 'query' || def.operation == 'mutation') {
      let decls: Array<ElmDecl> = [];
      // Name
      let name: string;
      if (def.name) {
        name = def.name.value;
      } else {
        name = 'AnonymousQuery';
      }
      let resultType = name[0].toUpperCase() + name.substr(1);
      let responseType = resultType;
      if(errorSpec) {
        responseType = "(Response " + resultType + ")";
      }
      // todo: Directives
      // SelectionSet
      let [fields, spreads] = walkSelectionSet(def.selectionSet, info);
      // todo: use spreads...
      decls.push(new ElmTypeAliasDecl(resultType, new ElmTypeRecord(fields)))
      // VariableDefinition
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

      let query = '';
      for (let name in qFragments) {
        query += print(qFragments[name]) + ' ';
      }

      query += print(def);
      let decodeFuncName = resultType[0].toLowerCase() + resultType.substr(1) + 'Decoder';
      expose.push(funcName);
      expose.push(resultType);

      let elmParamsType = new ElmTypeRecord(parameters.map(p => {

        let schemaType = p.schemaType;

        if (schemaType instanceof GraphQLNonNull) {
          schemaType = schemaType['ofType']
        }

        if (schemaType instanceof GraphQLList) {
          schemaType = schemaType['ofType']
        }

        if (schemaType instanceof GraphQLNonNull) {
          schemaType = schemaType['ofType']
        }

        if (schemaType instanceof GraphQLScalarType) {
          return new ElmFieldDecl(p.name, p.type);
        } else {

          // Generate type for input object
          let name = resultType + "_Input_" + p.name[0].toUpperCase() + p.name.substr(1);
          decls.push(new ElmTypeAliasDecl(name, p.type, []));
          expose.push(name);

          // Reference generated type
          return new ElmFieldDecl(p.name, new ElmTypeName(resultType + "_Input_" + p.name[0].toUpperCase() + p.name.substr(1)));
        }
      }));

      // Expose / reference input type for query
      let elmParamsDecl = [
      	new ElmParameterDecl('msg', new ElmTypeName("((Result GraphQLSpec.Error " + resultType + ")  -> msg)")),
      ];
      if(elmParamsType.fields.length > 0) {
      	elmParamsDecl.push(new ElmParameterDecl('params', new ElmTypeName(resultType + "_Input")));

        let paramName = resultType + "_Input";
        decls.push(new ElmTypeAliasDecl(paramName, elmParamsType, []));
        expose.push(paramName);
      }

      let methodParam = def.operation == 'query' ? `"${verb}" ` : '';

      decls.push(new ElmFunctionDecl(
         funcName, elmParamsDecl, new ElmTypeName(`Cmd msg`),
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
                     `\n                            Just val -> ${encoderForInputType(0, p.schemaType, true)} val` +
                     `\n                            Nothing -> Json.Encode.null`
               } else {
                 encoder = encoderForInputType(0, p.schemaType, true, 'params.' + p.name);
               }
               return `("${p.name}", ${encoder})`;
             })
             .join(`\n                , `) + '\n' +
             `                ]\n` +
             `    in\n` +
             `    ${def.operation} ${methodParam}endpointUrl graphQLQuery "${name}" graphQLParams msg ${decodeFuncName}`
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

  function encoderForInputType(depth: number, type: GraphQLType, isNonNull?: boolean, path?: string): string {
    let encoder: string;
    let value = path;
    let isMaybe = false
    if (type instanceof GraphQLNonNull) {
      type = type['ofType'];
    } else {
      isMaybe = true;    
      value = `o${depth}`;
    }
    if (type instanceof GraphQLInputObjectType) {
      let fieldEncoders: Array<string> = [];
      let fields = type.getFields();
      for (let name in fields) {
        let field = fields[name];
        let valuePath = value + '.' + field.name;
        fieldEncoders.push(`("${field.name}", ${encoderForInputType(depth + 1,field.type, false, valuePath)})`);
      }
      encoder = '(Json.Encode.object [' + fieldEncoders.join(`, `) + '])';
    } else if (type instanceof GraphQLList) {
      encoder = `(Json.Encode.list (\\x${depth} -> ` + encoderForInputType(depth + 1, type.ofType, true, 'x' + depth) + ') ' + value + ')';
    } else if (type instanceof GraphQLScalarType) {
      switch (type.name) {
        case 'Int': encoder = 'Json.Encode.int ' + value; break;
        case 'Float': encoder = 'Json.Encode.float ' + value; break;
        case 'Boolean': encoder = 'Json.Encode.bool ' + value; break;
        case 'UnixTimestamp': encoder = '(Json.Encode.int ((\\p -> p // 1000 ) <| Time.posixToMillis ' + value + ' )) '; break;
        case 'DateTime': encoder = 'Json.Encode.string ' + value; break;
        case 'String': encoder = 'Json.Encode.string ' + value; break;
        case 'ID': encoder = 'Json.Encode.string ' + value; break;
        default: encoder = 'Json.Encode.string ' + value; break;
      }
    } else if (type instanceof  GraphQLEnumType) {
      const values = type.getValues();
      const cases = values.map((v) => `${[(type.name + '_' + v.name[0].toUpperCase() + v.name.substr(1).toLowerCase())]} -> "${v.name}"`);
      encoder = `(case ${value} of \n` + cases.join('\n') + `)|> Json.Encode.string`;
    } else {
      throw new Error('not implemented: ' + type.constructor.name);
    }
    if (isMaybe) {
      encoder = `(maybeEncode (\\o${depth} -> ` + encoder + ') '+ path + ')';
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
    let info_type = info.getType();

    if (info_type instanceof GraphQLNonNull) {
        info_type = info_type['ofType']
    }

    if (info_type instanceof GraphQLList) {
        info_type = info_type['ofType']
    }

    if (info_type instanceof GraphQLNonNull) {
        info_type = info_type['ofType']
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
    let union = <GraphQLUnionType>info.getType();
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

    let info_type = info.getType();
    // Name
    let name = elmSafeName(field.name.value);
    // Alias
    if (field.alias) {
      name = elmSafeName(field.alias.value);
    }
    // todo: Arguments, such as `id: $someId`, where $someId is a variable
    let args = field.arguments; // e.g. id: "1000"

    // todo: Directives
    let include = field.directives.reduce((acc, {name, arguments: [argument]}) => {
      if (name.value === "include" && !argument.value.value) {
        return false;
      } else if (name.value === "skip" && argument.value.value) {
        return false;
      } else {
        return acc;
      }
    }, true);

    // SelectionSet
    if (field.selectionSet) {
      let isMaybe = false;
      if (info_type instanceof GraphQLNonNull) {
        info_type = info_type['ofType'];
      } else {
        isMaybe = true;
      }

      let isList = info_type instanceof GraphQLList;

      if (!include && !isList) {
        isMaybe = true;
      }

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
      return new ElmFieldDecl(name, type);
    } else {
      if (!info.getType()) {
        throw new Error('Unknown GraphQL field: ' + field.name.value);
      }
      let type = typeToElm(info.getType());
      if (!include && !(info_type instanceof GraphQLList)) {
        type = new ElmTypeApp('Maybe', [type]);
      }
      info.leave(field);
      return new ElmFieldDecl(name, type);
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
      case 'UnixTimestamp': elmType = new ElmTypeName('Time.Posix'); break;
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

export function elmSafeName(graphQlName: string): string {
  switch (graphQlName) {
    case '__typename': return 'typename_';
    case 'type': return "type_";
    case 'Task': return "Task_";
    case 'List': return "List_";
    case 'Http': return "Http_";
    case 'GraphQL': return "GraphQL_";
    // todo: more...
    default: return graphQlName;
  }
}
