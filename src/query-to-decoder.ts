/**
 * Copyright (c) 2016, John Hewson
 * All rights reserved.
 */

/// <reference path="../typings/graphql-types.d.ts" />
/// <reference path="../typings/graphql-language.d.ts" />
/// <reference path="../typings/graphql-utilities.d.ts" />

import {
  OperationDefinition,
  FragmentDefinition,
  FragmentSpread,
  InlineFragment,
  SelectionSet,
  Field,
  Document,
  parse
} from "graphql/language";

import {
  ElmFieldDecl,
  ElmDecl,
  ElmTypeDecl,
  ElmParameterDecl,
  ElmExpr,
  moduleToString,
  typeToString
} from './elm-ast';

import {
  GraphQLSchema,
  GraphQLNonNull,
  GraphQLList,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLType,
  GraphQLInputType,
  GraphQLUnionType
} from 'graphql/type';

import {
  TypeInfo,
  buildClientSchema,
  introspectionQuery,
  typeFromAST,
} from 'graphql/utilities';

import {
  FragmentDefinitionMap,
  GraphQLEnumMap,
  elmSafeName,
  typeToElm
} from './query-to-elm';


// TODO: Why are these next two function necessary?
// TODO: This module does some weird type splitting and unifying. Is there a simpler way?
// TODO: Document the structure of the output Elm decoder
// TODO: It may be possible to simplify this code if it is written to work with a Decoder AST type rather than the lower level AST types it currently uses

// Generate an Elm JSON decoder for the provided GraphQL query
export function decoderForQuery(
  def: OperationDefinition,
  info: TypeInfo,
  schema: GraphQLSchema,
  fragmentDefinitionMap: FragmentDefinitionMap,
  seenFragments: FragmentDefinitionMap
): ElmExpr {
  return decoderFor(def, info, schema, fragmentDefinitionMap, seenFragments);
}


// Generate an Elm JSON decoder for the provided GraphQL Fragment
export function decoderForFragment(
  def: FragmentDefinition,
  info: TypeInfo,
  schema: GraphQLSchema,
  fragmentDefinitionMap: FragmentDefinitionMap,
  seenFragments: FragmentDefinitionMap
): ElmExpr {
  return decoderFor(def, info, schema, fragmentDefinitionMap, seenFragments);
}


// Generate an Elm JSON Decoder fort the provided GraphQL Query or Fragment.

// Notes to aid future readers:
// - A GraphQL Operation is a query or a mutation.

// TODO: Why does this declare a bunch of local functions?
export function decoderFor(
  def: OperationDefinition | FragmentDefinition,
  info: TypeInfo,
  schema: GraphQLSchema,
  fragmentDefinitionMap: FragmentDefinitionMap, // During compilation of a query fragments are spread. This contains the list of fragment definitions used for spreading
  seenFragments: FragmentDefinitionMap
): ElmExpr {
  function walkDefinition(def: OperationDefinition | FragmentDefinition, info: TypeInfo) {
    if (def.kind == 'OperationDefinition') {
      return walkOperationDefinition(<OperationDefinition>def, info);
    } else if (def.kind == 'FragmentDefinition') {
      return walkFragmentDefinition(<FragmentDefinition>def, info);
    }
  }


  // Convert the provided GraphQL operation to an Elm Expression
  function walkOperationDefinition(def: OperationDefinition, info: TypeInfo): ElmExpr {
    info.enter(def);

    // There are only two types of operations defined in the GraphQL spec: Query and Mutation.
    // However, the GraphQL parsing library being used here also supports subscriptions.
    // We just ignore those. May be neat to add support for them at some point though using
    // elm's websocket support?
    if (def.operation == 'query' || def.operation == 'mutation') {
      let decls: Array<ElmDecl> = [];

      let name: string;
      if (def.name) {
        name = def.name.value;
      } else {
        name = 'AnonymousQuery';
      }

      // Create the name of the Elm type which will be returned from this operation
      let resultType = name[0].toUpperCase() + name.substr(1);

      // TODO: Support for directives

      // Get the list of selected fields
      let expr = walkSelectionSet(def.selectionSet, info);

      // List of field names for the result record type
      let parameters: Array<ElmParameterDecl> = [];

      if (def.variableDefinitions) {
        for (let varDef of def.variableDefinitions) {
          let name = varDef.variable.name.value;

          let type = typeToString(typeToElm(typeFromAST(schema, varDef.type)), 0);

          // TODO: Support for default values

          parameters.push({ name, type });
        }
      }

      info.leave(def);

      return { expr: 'map ' + resultType + ' ' + expr.expr };
    }
  }


  // Convert the provided GraphQL Fragment to an Elm expression
  function walkFragmentDefinition(def: FragmentDefinition, info: TypeInfo): ElmExpr {
    info.enter(def);

    let name = def.name.value;
    let decls: Array<ElmDecl> = [];
    let resultType = name[0].toUpperCase() + name.substr(1);

    // TODO: Support GraphQL Directives

    let fields = walkSelectionSet(def.selectionSet, info);
    let fieldNames = getSelectionSetFields(def.selectionSet, info);
    let shape = `(\\${fieldNames.join(' ')} -> { ${fieldNames.map(f => f + ' = ' + f).join(', ')} })`;

    info.leave(def);

    return { expr: 'map ' + shape + ' ' + fields.expr };
  }


  // Convert the selection set (the stuff between the braces a GraphQL query) into an Elm Expression
  // TODO: There seems to be some duplicated code between this function and getSelectionSetFields
  function walkSelectionSet(selSet: SelectionSet, info: TypeInfo, seenFields: Array<string> = []): ElmExpr {
    info.enter(selSet);

    let fields: Array<ElmExpr> = [];

    for (let sel of selSet.selections) {
      // A selection can be either a regular field, a fragment spread, or an inline fragment
      // Expand a regular field
      if (sel.kind == 'Field') {
        let field = <Field>sel;
        var name = field.alias == null ? field.name.value : field.alias.value;

        // Ignore duplicate fields. The GraphQL spec allows this for some reason?
        if (seenFields.indexOf(name) == -1) {
          fields.push(walkField(field, info));
          seenFields.push(name);
        }
      }

      // Expand fragment spread
      else if (sel.kind == 'FragmentSpread') {
        let spreadName = (<FragmentSpread>sel).name.value;
        let fragmentDef = fragmentDefinitionMap[spreadName];
        fields.push(walkSelectionSet(fragmentDef.selectionSet, info, seenFields));
      }

      // Expand an Inline Fragment
      // TODO: Document why this should not happen
      else if (sel.kind == 'InlineFragment') {
        throw new Error('Should not happen');
      }
    }

    info.leave(selSet);

    // TODO: Document why we filter for e.length > 0
    return { expr: fields.map(f => f.expr).filter(e => e.length > 0).join('\n        |> apply ') }
  }


  // Get the list of fields for the provided selection set
  function getSelectionSetFields(selSet: SelectionSet, info: TypeInfo): Array<string> {
    info.enter(selSet);

    let fields: Array<string> = [];

    for (let sel of selSet.selections) {
      if (sel.kind == 'Field') {
        let field = <Field>sel;
        let name = elmSafeName(field.name.value);
        if (field.alias) {
          name = elmSafeName(field.alias.value);
        }
        if (fields.indexOf(name) == -1) {
          fields.push(name);
        }
      } else if (sel.kind == 'FragmentSpread') {
        // expand out all fragment spreads
        let spreadName = (<FragmentSpread>sel).name.value;
        let def = fragmentDefinitionMap[spreadName];
        for (let name of getSelectionSetFields(def.selectionSet, info)) {
          if (fields.indexOf(name) == -1) {
            fields.push(name);
          }
        }
      } else if (sel.kind == 'InlineFragment') {
        throw new Error('Should not happen');
      }
    }
    info.leave(selSet);
    return fields;
  }


  // Convert a nested query field into an elm expression
  // TODO: This function could probably be more clearly written if made less procedural
  function walkField(field: Field, info: TypeInfo): ElmExpr {
    info.enter(field);

    let name = elmSafeName(field.name.value);
    let originalName = field.name.value;
    let typeInfo: any = info.getType();
    let isMaybe = false;

    // Output a maybe type if the GraphQL type is nullable
    if (typeInfo instanceof GraphQLNonNull) {
      typeInfo = typeInfo['ofType'];
    } else {
      isMaybe = true;
    }

    // Output the alias name rather than the actual field name if one exists
    if (field.alias) {
      name = elmSafeName(field.alias.value);
      originalName = field.alias.value;
    }

    // TODO: Document why arguments are handled here and how they influence the output decoder
    let args = field.arguments;

    // TODO: Move this prefix declaration to the top with all the other declarations?
    let prefix = '';
    if (typeInfo instanceof GraphQLList) {
      typeInfo = typeInfo['ofType'];
      prefix = 'list ';
    }

    if (typeInfo instanceof GraphQLNonNull) {
      typeInfo = typeInfo['ofType'];
    }

    // A union must be walked in a special way.
    // A scalar must be generated directly.
    // All other types have a selection set that must be walked.
    // TODO: Reconstruct these weirdly nested conditionals. It would be clearer to condition on every possible type
    if (typeInfo instanceof GraphQLUnionType) {
      let expr = walkUnion(originalName, field, info);
      return expr;
    } else {
      if (field.selectionSet) {
        let fields = walkSelectionSet(field.selectionSet, info);

        // TODO: Why is this here instead of just before the return like all the other methods?
        info.leave(field);

        let fieldNames = getSelectionSetFields(field.selectionSet, info);
        let shape = `(\\${fieldNames.join(' ')} -> { ${fieldNames.map(f => f + ' = ' + f).join(', ')} })`;
        let left = '(field "' + originalName + '" \n';
        let right = '(map ' + shape + ' ' + fields.expr + '))';

        // TODO: Should this be using the makeIndent function in elm-ast?
        let indent = '        ';
        if (prefix) {
          right = '(' + prefix + right + ')';
        }

        if (isMaybe) {
          right = '(' + 'maybe ' + right + ')';
        }

        return { expr: left + indent + right };
      } else {
        let decoder = leafTypeToDecoder(typeInfo);

        let right = '(field "' + originalName + '" (' + prefix + decoder +'))';

        if (isMaybe) {
          right = '(maybe ' + right + ')';
        }

        info.leave(field);
        return { expr: right };
      }
    }
  }


  // Generate an Elm Decoder for the provided union
  function walkUnion(originalName: string, field: Field, info: TypeInfo): ElmExpr {
    let decoder = '\n        (\\typename -> case typename of';
    let indent = '            ';

    let union_type: any = info.getType();
    let union_name = "";

    let prefix = "";
    let isMaybe = true;

    // TODO:
    //   These ifs are unwrapping non nullables and list types to their base types.
    //   Does it handle nested lists?
    if (union_type instanceof GraphQLNonNull) {
      union_type = union_type['ofType'];
      isMaybe = false;
    }

    if (union_type instanceof GraphQLList) {
      union_type = union_type['ofType'];
      prefix = "list ";
    }

    if (union_type instanceof GraphQLNonNull) {
        union_type = union_type['ofType'];
    }

    if (union_type instanceof GraphQLUnionType) {
      union_name = union_type.name;
    }

    for (let sel of field.selectionSet.selections) {
      if (sel.kind == 'InlineFragment') {
        let inlineFragment = <InlineFragment> sel;
        decoder += `\n${indent}"${inlineFragment.typeCondition.name.value}" -> `;

        info.enter(inlineFragment);
        let fields = walkSelectionSet(inlineFragment.selectionSet, info);
        info.leave(inlineFragment);

        let fieldNames = getSelectionSetFields(inlineFragment.selectionSet, info);
        let ctor = elmSafeName((union_name + '_' + inlineFragment.typeCondition.name.value));
        let shape = `(\\${fieldNames.join(' ')} -> ${ctor} { ${fieldNames.map(f => f + ' = ' + f).join(', ')} })`;
        let right = '(map ' + shape + ' ' + fields.expr.split('\n').join(' ') + '\n)';
        decoder += right;
      } else if (sel.kind == 'Field') {
        let field = <Field>sel;

        if (field.name.value != '__typename') {
          throw new Error('Unexpected field: ' + field.name.value);
        }
      } else if (sel.kind == 'FragmentSpread') {
        let spreadName = (<FragmentSpread>sel).name.value;
        let def = fragmentDefinitionMap[spreadName];
        let name = def.typeCondition.name.value;
        decoder += `\n${indent}"${name}" -> `;

        info.enter(def)
        let fields = walkSelectionSet(def.selectionSet, info);
        let fieldNames = getSelectionSetFields(def.selectionSet, info);
        info.leave(def)

        let ctor = elmSafeName((union_name+'_'+name));
        let shape = `(\\${fieldNames.join(' ')} -> ${ctor} { ${fieldNames.map(f => f + ' = ' + f).join(', ')} })`;
        let right = '(map ' + shape + ' ' + fields.expr.split('\n').join(' ') + '\n)';
        decoder += right;
      } else {
        throw new Error('Unexpected: ' + sel.kind);
      }
    }

    decoder += `\n${indent}_ -> fail "Unexpected union type")`;

    decoder = '((field "__typename" string) |> andThen ' + decoder + ')';

    if (prefix) {
        decoder = '(' + prefix + decoder + ')';
    }

    if (isMaybe) {
        decoder = '(' + 'maybe ' + decoder + ')';
    }

    return { expr: '(field "' + originalName + '" ' + decoder +')' };
  }


  // Create an Elm decoder for the given leaf (non-nested) type
  // TODO: Why doesn't this return an ElmExpr?
  function leafTypeToDecoder(type: GraphQLType): string {
    if (type instanceof GraphQLNonNull) {
      type = type['ofType'];
    }

    if (type instanceof GraphQLScalarType) {
      switch (type.name) {
        case 'Int': return 'int';
        case 'Float': return 'float';
        case 'Boolean': return 'bool';
        case 'ID':
        case 'DateTime': return 'string';
        case 'String': return 'string';
        default: return 'string';
      }
    } else if (type instanceof GraphQLEnumType) {
      return type.name.toLowerCase() + 'Decoder';
    } else {
      throw new Error('not a leaf type: ' + (<any>type).name);
    }
  }

  return walkDefinition(def, info);
}
