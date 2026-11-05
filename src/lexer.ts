import { Slex, Token as SlexToken } from "@scinorandex/slex";

// prettier-ignore
export enum TokenType {
  L_PAREN, R_PAREN, L_BRACE, R_BRACE, L_SQ_BRACE, R_SQ_BRACE,
  PLUS, MINUS, MULTIPLY, DIVIDE,
  EQUALS, EQUAL_EQUAL, NOT_EQUAL,
  LESS_THAN, GREATER_THAN, LESS_EQUAL, GREATER_EQUAL,
  NOT, AND, OR,
  COMMA, SEMICOLON, COLON, DOT, ARROW,
  NUMBER_LITERAL, STRING_LITERAL, BOOLEAN_LITERAL, NULL_LITERAL,
  IDENTIFIER, ASYNC, FUNCTION, LET, TYPE, RETURN, AWAIT,
  EXPORT, CLASS, EXTENDS, PUBLIC, PROTECTED, PRIVATE,
  IF, ELSE, FOR, WHILE, DO, BREAK, CONTINUE,
  EOF,
}

export type Metadata = {};
export type Token = SlexToken<TokenType, Metadata>;
const lexerGenerator = new Slex<TokenType, Metadata>({
  EOF_TYPE: TokenType.EOF,
  isHigherPrecedence: ({ current, next }) => current === TokenType.IDENTIFIER,
});

lexerGenerator.addCharacterClass("__symbol_no_quote", (ch) =>
  ch == `"` ? false : /^\p{P}+$/u.test(ch) || /^\p{S}+$/u.test(ch),
);
lexerGenerator.addRule("lparen", "$(", TokenType.L_PAREN);
lexerGenerator.addRule("rparen", "$)", TokenType.R_PAREN);
lexerGenerator.addRule("lbrace", "${", TokenType.L_BRACE);
lexerGenerator.addRule("rbrace", "$}", TokenType.R_BRACE);
lexerGenerator.addRule("lsquare", "$[", TokenType.L_SQ_BRACE);
lexerGenerator.addRule("rsquare", "$]", TokenType.R_SQ_BRACE);

lexerGenerator.addRule("plus", "$+", TokenType.PLUS);
lexerGenerator.addRule("minus", "$-", TokenType.MINUS);
lexerGenerator.addRule("multiply", "$*", TokenType.MULTIPLY);
lexerGenerator.addRule("divide", "$/", TokenType.DIVIDE);
lexerGenerator.addRule("equal_equal", "$=$=", TokenType.EQUAL_EQUAL);
lexerGenerator.addRule("not_equal", "$!$=", TokenType.NOT_EQUAL);
lexerGenerator.addRule("less_equal", "$<$=", TokenType.LESS_EQUAL);
lexerGenerator.addRule("greater_equal", "$>$=", TokenType.GREATER_EQUAL);
lexerGenerator.addRule("less_than", "$<", TokenType.LESS_THAN);
lexerGenerator.addRule("greater_than", "$>", TokenType.GREATER_THAN);
lexerGenerator.addRule("not", "$!", TokenType.NOT);
lexerGenerator.addRule("and", "$&$&", TokenType.AND);
lexerGenerator.addRule("or", "$|$|", TokenType.OR);

lexerGenerator.addRule("comma", "$,", TokenType.COMMA);
lexerGenerator.addRule("semicolon", "$;", TokenType.SEMICOLON);
lexerGenerator.addRule("equals", "$=", TokenType.EQUALS);
lexerGenerator.addRule("colon", "$:", TokenType.COLON);
lexerGenerator.addRule("dot", "$.", TokenType.DOT);
lexerGenerator.addRule("arrow", "$=$>", TokenType.ARROW);

lexerGenerator.addRule("number_literal", "(${__decimal_digit})+", TokenType.NUMBER_LITERAL);
lexerGenerator.addRule("character", "${__letter} | ${__decimal_digit} | ${__symbol_no_quote} | $ ");
lexerGenerator.addRule("string_literal", '$"(${character} | $\')*$"', TokenType.STRING_LITERAL, (str) =>
  str.substring(1, str.length - 1).replaceAll("\\n", "\n"),
);
lexerGenerator.addRule("true", "true", TokenType.BOOLEAN_LITERAL);
lexerGenerator.addRule("false", "false", TokenType.BOOLEAN_LITERAL);
lexerGenerator.addRule("null", "null", TokenType.NULL_LITERAL);

lexerGenerator.addRule("identifier", "(${__letter}|$_)(${__letter}|${__decimal_digit}|$_)*", TokenType.IDENTIFIER);
lexerGenerator.addRule("async", "async", TokenType.ASYNC);
lexerGenerator.addRule("function", "function", TokenType.FUNCTION);
lexerGenerator.addRule("let", "let", TokenType.LET);
lexerGenerator.addRule("type", "type", TokenType.TYPE);
lexerGenerator.addRule("return", "return", TokenType.RETURN);
lexerGenerator.addRule("await", "await", TokenType.AWAIT);
lexerGenerator.addRule("export", "export", TokenType.EXPORT);
lexerGenerator.addRule("class", "class", TokenType.CLASS);
lexerGenerator.addRule("extends", "extends", TokenType.EXTENDS);
lexerGenerator.addRule("public", "public", TokenType.PUBLIC);
lexerGenerator.addRule("protected", "protected", TokenType.PROTECTED);
lexerGenerator.addRule("private", "private", TokenType.PRIVATE);
lexerGenerator.addRule("if", "if", TokenType.IF);
lexerGenerator.addRule("else", "else", TokenType.ELSE);
lexerGenerator.addRule("for", "for", TokenType.FOR);
lexerGenerator.addRule("while", "while", TokenType.WHILE);
lexerGenerator.addRule("do", "do", TokenType.DO);
lexerGenerator.addRule("break", "break", TokenType.BREAK);
lexerGenerator.addRule("continue", "continue", TokenType.CONTINUE);

export function generate_lexer(source: string) {
  return lexerGenerator.generate(source, () => ({}));
}
