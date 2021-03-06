import {IAngularStatic} from "angular";

import {TeradataExpressionType} from "./teradata-expression-type";
import {TeradataScript} from "./teradata-script";
import {ParseException} from "../parse-exception";

declare const angular: IAngularStatic;

/**
 * Context for formatting a Teradata conversion string.
 */
interface FormatContext {

    /**
     * Format parameters
     */
    args: TeradataExpression[];

    /**
     * Current position within {@code args}
     */
    index: number;

    /**
     * Indicates that all columns should have an alias
     */
    requireAlias: boolean;
}

/**
 * Type of source for {@link TeradataExpression}
 */
type SourceType = string | TeradataScript;

/**
 * An expression in a Teradata SQL script.
 */
export class TeradataExpression {

    /** Regular expression for matching the column alias */
    static COLUMN_ALIAS_REGEXP = /^"([^"]+)"$| AS "([^"]+)"$/;

    /** TernJS directive for the expression template */
    static EXPRESSION_DIRECTIVE = "!sqlExpr";

    /** Regular expression for conversion strings */
    static FORMAT_REGEX = /%([?*,@]*)([cos])/g;

    /** TernJS directive for the string format template */
    static TERADATA_DIRECTIVE = "!sql";

    /** TernJS directive for the return type */
    static TYPE_DIRECTIVE = "!sqlType";

    /**
     * Constructs a {@code TeradataExpression}
     *
     * @param source - Teradata code
     * @param type - result type
     * @param start - column of the first character in the original expression
     * @param end - column of the last character in the original expression
     */
    constructor(public source: SourceType, public type: TeradataExpressionType, public start: number, public end: number) {
    }

    /**
     * Adds an alias to the specified expression.
     */
    static addColumnAlias(expression: string): string {
        return expression + " AS \"" + expression.replace(/"/g, "") + "\"";
    }

    /**
     * Formats the specified string by replacing the type specifiers with the specified parameters.
     *
     * @param str - the Teradata conversion string to be formatted
     * @param requireAlias - true to ensure that all columns have an alias
     * @param args - the format parameters
     * @returns the formatted string
     * @throws {Error} if the conversion string is not valid
     * @throws {ParseException} if a format parameter cannot be converted to the specified type
     */
    static format(str: string, requireAlias: boolean, ...args: TeradataExpression[]): string {
        // Convert arguments
        const context: FormatContext = {
            args: args,
            index: 0,
            requireAlias: requireAlias
        };
        const result = str.replace(TeradataExpression.FORMAT_REGEX, angular.bind(str, TeradataExpression.replace, context) as any);

        // Verify all arguments converted
        if (context.index >= context.args.length) {
            return result;
        } else {
            throw new ParseException("Too many arguments for conversion.");
        }
    }

    /**
     * Creates a Teradata expression from a function definition.
     *
     * @param definition - the function definition
     * @param node - the source abstract syntax tree
     * @param $interpolate - interpolation service
     * @param var_args - the format parameters
     * @returns the Teradata expression
     * @throws {Error} if the function definition is not valid
     * @throws {ParseException} if a format parameter cannot be converted to the required type
     */
    static fromDefinition(definition: any, node: acorn.Node, $interpolate: angular.IInterpolateService, ...var_args: TeradataExpression[]): TeradataExpression {
        const parseFunction: (template: string, requireAlias: boolean) => string = definition[TeradataExpression.EXPRESSION_DIRECTIVE]
            ? (template: string, requireAlias: boolean) => TeradataExpression.parseExpressionString(template, requireAlias, $interpolate, var_args)
            : (template: string, requireAlias: boolean) => TeradataExpression.format(template, requireAlias, ...var_args);
        let source: SourceType;
        const template = definition[TeradataExpression.EXPRESSION_DIRECTIVE] ? definition[TeradataExpression.EXPRESSION_DIRECTIVE] : definition[TeradataExpression.TERADATA_DIRECTIVE];

        // Parse template
        if (typeof template === "string") {
            source = parseFunction(template, definition[TeradataExpression.TYPE_DIRECTIVE] === "Select");
        } else {
            source = {
                groupBy: template.groupBy ? parseFunction(template.groupBy, false) : null,
                having: template.having ? parseFunction(template.having, false) : null,
                keywordList: template.keywordList ? parseFunction(template.keywordList, false) : null,
                selectList: template.selectList ? parseFunction(template.selectList, true) : null,
                where: template.where ? parseFunction(template.where, false) : null
            };
        }

        // Return expression
        return new TeradataExpression(source, TeradataExpressionType.valueOf(definition[TeradataExpression.TYPE_DIRECTIVE]), node.start, node.end);
    }

    /**
     * Indicates if the expression does not have a column alias.
     */
    static needsColumnAlias(expression: string): boolean {
        return !TeradataExpression.COLUMN_ALIAS_REGEXP.test(expression);
    }

    /**
     * Gets the column alias for the specified expression.
     */
    private static getColumnAlias(expression: TeradataExpression): string {
        const match = TeradataExpression.COLUMN_ALIAS_REGEXP.exec(expression.source as string);
        if (match) {
            return "\"" + match.find((value, index) => index !== 0 && value != null) + "\"";
        } else {
            return "\"" + (expression.source as string).replace(/"/g, "") + "\"";
        }
    }

    /**
     * Evaluates the specified expression template.
     */
    private static parseExpressionString(template: string, requireAlias: boolean, $interpolate: angular.IInterpolateService, args: TeradataExpression[]): string {
        return $interpolate(template)({
            args: args,
            getColumnAlias: TeradataExpression.getColumnAlias,
            toColumn: (expr: TeradataExpression) => TeradataExpression.toColumn(expr, requireAlias),
            toObject: TeradataExpression.toObject,
            toString: TeradataExpression.toString
        });
    }

    /**
     * Converts the next argument to the specified type for a Teradata conversion string.
     *
     * @param context - the format context
     * @param match - the conversion specification
     * @param flags - the conversion flags
     * @param type - the type specifier
     * @returns the converted Teradata code
     * @throws {Error} if the type specifier is not supported
     * @throws {ParseException} if the format parameter cannot be converted to the specified type
     */
    private static replace(context: FormatContext, match: string, flags: string, type: string): string {
        // Parse flags
        let arrayType = null;
        let comma = false;
        let end = context.index + 1;

        for (let i = 0; i < flags.length; ++i) {
            switch (flags.charAt(i)) {
                case ",":
                    comma = true;
                    break;

                case "?":
                    end = (context.index < context.args.length) ? end : 0;
                    break;

                case "*":
                    end = context.args.length;
                    break;

                case "@":
                    arrayType = type;
                    type = "@";
                    break;

                default:
                    throw new Error("Unsupported conversion flag: " + flags.charAt(i));
            }
        }

        // Validate arguments
        if (end > context.args.length) {
            throw new ParseException("Not enough arguments for conversion");
        }

        // Convert to requested type
        let first = true;
        let result = "";

        for (; context.index < end; ++context.index) {
            // Argument separator
            if (comma || !first) {
                result += ", ";
            } else {
                first = false;
            }

            // Conversion
            let arg = context.args[context.index];

            switch (type) {
                case "c":
                    result += TeradataExpression.toColumn(arg, context.requireAlias);
                    break;

                case "o":
                    result += TeradataExpression.toObject(arg);
                    break;

                case "s":
                    result += TeradataExpression.toString(arg);
                    break;

                default:
                    throw new Error("Not a recognized conversion type: " + type);
            }
        }

        return result;
    }

    /**
     * Converts the specified Teradata expression to a Column type.
     *
     * @param expression - the Teradata expression
     * @param requireAlias - true to ensure that the column has an alias
     * @returns the Teradata code for the new type
     * @throws {ParseException} if the expression cannot be converted to a column
     */
    private static toColumn(expression: TeradataExpression, requireAlias: boolean): SourceType {
        if (TeradataExpressionType.COLUMN.equals(expression.type) || TeradataExpressionType.LITERAL.equals(expression.type)) {
            if (requireAlias && TeradataExpression.needsColumnAlias(expression.source as string)) {
                return TeradataExpression.addColumnAlias(expression.source as string);
            } else {
                return expression.source;
            }
        }
        throw new ParseException("Expression cannot be converted to a column: " + expression.type, expression.start);
    }

    /**
     * Converts the specified Spark expression to an object.
     *
     * @param expression - the Spark expression
     * @returns the Spark code for the object
     * @throws {ParseException} if the expression cannot be converted to an object
     */
    private static toObject(expression: TeradataExpression): SourceType {
        if (TeradataExpressionType.isObject(expression.type.toString())) {
            return expression.source;
        } else if (TeradataExpressionType.LITERAL.equals(expression.type)) {
            if ((expression.source as string).charAt(0) === "\"" || (expression.source as string).charAt(0) === "'") {
                return TeradataExpression.toString(expression);
            } else {
                return expression.source;
            }
        } else {
            throw new ParseException("Expression cannot be converted to an object: " + expression.type, expression.start);
        }
    }

    /**
     * Converts the specified Teradata expression to a string literal.
     *
     * @param expression - the Teradata expression
     * @returns the Teradata code for the string literal
     * @throws {ParseException} if the expression cannot be converted to a string
     */
    private static toString(expression: TeradataExpression): SourceType {
        if (!TeradataExpressionType.LITERAL.equals(expression.type)) {
            throw new ParseException("Expression cannot be converted to a string: " + expression.type, expression.start);
        }
        if ((expression.source as string).charAt(0) === "'") {
            return (expression.source as string).replace(/\\'/g, "''");
        }
        if ((expression.source as string).charAt(0) === "\"") {
            return (expression.source as string).replace(/\\"/g, "\"\"");
        }
        return "'" + expression.source + "'";
    }
}
