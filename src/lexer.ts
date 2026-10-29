import { Slex, Token as SlexToken } from "@scinorandex/slex";

// prettier-ignore
export enum TokenType {
  L_PAREN, R_PAREN, L_BRACE, R_BRACE,
  PLUS, MINUS, STAR, SLASH,
  COMMA, SEMICOLON, EQUALS,
  NUMBER_LITERAL, STRING_LITERAL, BOOLEAN_LITERAL,
  IDENTIFIER, ASYNC, FUNCTION, LET, RETURN, AWAIT,
  EOF,
}

export type Metadata = {};
export type Token = SlexToken<TokenType, Metadata>;
const lexerGenerator = new Slex<TokenType, Metadata>({
  EOF_TYPE: TokenType.EOF,
  isHigherPrecedence: ({ current, next }) => current === TokenType.IDENTIFIER,
});

lexerGenerator.addRule("lparen", "$(", TokenType.L_PAREN);
lexerGenerator.addRule("rparen", "$)", TokenType.R_PAREN);
lexerGenerator.addRule("lbrace", "${", TokenType.L_BRACE);
lexerGenerator.addRule("rbrace", "$}", TokenType.R_BRACE);

lexerGenerator.addRule("plus", "$+", TokenType.PLUS);
lexerGenerator.addRule("minus", "$-", TokenType.MINUS);
lexerGenerator.addRule("star", "$*", TokenType.STAR);
lexerGenerator.addRule("forward_slash", "$/", TokenType.SLASH);

lexerGenerator.addRule("comma", "$,", TokenType.COMMA);
lexerGenerator.addRule("semicolon", "$;", TokenType.SEMICOLON);
lexerGenerator.addRule("equals", "$=", TokenType.EQUALS);

lexerGenerator.addRule("number_literal", "(${__decimal_digit})+", TokenType.NUMBER_LITERAL);
lexerGenerator.addRule("character", "${__letter} | ${__decimal_digit} | ${__symbols} | $ ");
lexerGenerator.addRule("string_literal", '$"(${character} | $\')*$"', TokenType.STRING_LITERAL, (str) =>
  str.substring(1, str.length - 1).replaceAll("\\n", "\n"),
);
lexerGenerator.addRule("true", "true", TokenType.BOOLEAN_LITERAL);
lexerGenerator.addRule("false", "false", TokenType.BOOLEAN_LITERAL);

lexerGenerator.addRule("identifier", "(${__letter}|$_)(${__letter}|${__decimal_digit}|$_)*", TokenType.IDENTIFIER);
lexerGenerator.addRule("async", "async", TokenType.ASYNC);
lexerGenerator.addRule("function", "function", TokenType.FUNCTION);
lexerGenerator.addRule("let", "let", TokenType.LET);
lexerGenerator.addRule("return", "return", TokenType.RETURN);
lexerGenerator.addRule("await", "await", TokenType.AWAIT);

export function generate_lexer(source: string) {
  return lexerGenerator.generate(source, () => ({}));
}
