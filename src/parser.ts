import {
  CompileOptions,
  ExecuteOptions,
  LogCallback,
  ASCNode,
  Token,
  ASCType
} from "./types";
import { hanzi2num, hanzi2numstr, num2hanzi, bool2hanzi } from "./hanzi2num";
import { hanzi2pinyin } from "./hanzi2pinyin";
import { importReader } from "./reader";
import { expandMacros, extractMacros } from "./macro";
import { version } from "./version";
import { NUMBER_KEYWORDS, KEYWORDS } from "./keywords";
import { STDLIB } from "./stdlib";
import transpilers from "./transpilers";

var { typecheck, printSignature } = require("./typecheck");

const defaultTrustedHosts = [
  "https://raw.githubusercontent.com/LingDong-/wenyan-lang/master"
];

function wy2tokens(
  txt: string,
  assert = (msg, pos, b) => {
    if (!b) console.log(`ERROR@${pos}: ${msg}`);
  }
) {
  var tokens: any[] = [];
  var tok = "";
  var idt = false;
  var num = false;
  var litlvl = 0;
  var data = false;

  var i = 0;

  function enddata() {
    if (data) {
      tokens.push(["data", tok, i]);
      data = false;
      tok = "";
    }
  }
  function endnum() {
    if (num) {
      const numStr = hanzi2numstr(tok);
      assert(`Invalid number "${tok}".`, i, numStr != null);
      tokens.push(["num", numStr, i]);
      tok = "";
      num = false;
    }
  }

  while (i < txt.length) {
    if (
      txt[i] == "。" ||
      txt[i] == "、" ||
      txt[i] == "\n" ||
      txt[i] == "\r" ||
      txt[i] == "\t" ||
      txt[i] == " "
    ) {
      if (idt || data) {
        tok += txt[i];
      }
    } else if ((txt[i] == "「" && txt[i + 1] == "「") || txt[i] == "『") {
      var is_sin = txt[i] == "「";
      if (litlvl == 0) {
        enddata();
        endnum();
        idt = true;
        tok = "";
      } else {
        tok += txt[i];
        if (is_sin) {
          tok += txt[i + 1];
        }
      }
      litlvl++;
      if (is_sin) {
        i++;
      }
    } else if (
      (txt[i] == "」" &&
        txt[i + 1] == "」" &&
        (txt[i + 2] != "」" || txt[i + 3] == "」")) ||
      txt[i] == "』"
    ) {
      var is_sin = txt[i] == "」";
      litlvl--;
      if (litlvl == 0) {
        tokens.push(["lit", `"${tok}"`, i + 1]);
        idt = false;
        tok = "";
      } else {
        tok += txt[i];
        if (is_sin) {
          tok += txt[i + 1];
        }
      }
      if (is_sin) {
        i++;
      }
    } else if (litlvl > 0) {
      tok += txt[i];
    } else {
      if (txt[i] == "「") {
        enddata();
        endnum();
        idt = true;
        tok = "";
      } else if (txt[i] == "」") {
        tokens.push(["iden", tok, i]);
        idt = false;
        tok = "";
      } else {
        if (idt) {
          tok += txt[i];
        } else if (num) {
          if (NUMBER_KEYWORDS.includes(txt[i])) {
            tok += txt[i];
          } else {
            endnum();
            i--;
          }
        } else {
          var ok = false;
          for (var k in KEYWORDS) {
            ok = true;
            for (var j = 0; j < k.length; j++) {
              if (txt[i + j] != k[j]) {
                ok = false;
                break;
              }
            }
            if (ok) {
              enddata();
              var kinfo = KEYWORDS[k];
              while (kinfo.length < 2) {
                kinfo.push(undefined);
              }
              i += k.length - 1;
              tokens.push([...kinfo, i]);
              break;
            }
          }
          if (!ok) {
            if (NUMBER_KEYWORDS.includes(txt[i])) {
              num = true;
              tok = txt[i];
            } else {
              tok += txt[i];
              data = true;
            }
          }
        }
      }
    }
    i++;
  }
  if (tok.length) {
    if (num) {
      const numStr = hanzi2numstr(tok);
      assert(`Invalid number "${tok}".`, i, numStr != null);
      tokens.push(["num", numStr]);
    } else if (data) {
      tokens.push(["data", tok]);
    } else {
      assert("Unterminated identifier.", i, false);
    }
  }
  return tokens;
}

var idenMap = {};
function tokenRomanize(tokens, method) {
  function noDup(x) {
    for (var k in idenMap) {
      if (idenMap[k] == x) {
        return false;
      }
    }
    return true;
  }
  function isRoman(x) {
    return x.replace(/[ -~]/g, "").length == 0;
  }
  function hanzi2unicodeEntry(s) {
    var y = "";
    for (var c of s) {
      y +=
        "U" +
        c
          .charCodeAt(0)
          .toString(16)
          .toUpperCase();
    }
    return y;
  }
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i][0] == "iden" && !isRoman(tokens[i][1])) {
      var r = idenMap[tokens[i][1]];
      var key = tokens[i][1];
      if (r !== undefined) {
        tokens[i][1] = r;
      } else {
        if (method == "pinyin") {
          r = hanzi2pinyin(tokens[i][1], "pinyin");
        } else if (method == "baxter") {
          r = hanzi2pinyin(tokens[i][1], "baxter");
        } else if (method == "unicode") {
          r = hanzi2unicodeEntry(tokens[i][1]);
        } else {
          r = hanzi2pinyin(tokens[i][1]); // legacy
          //console.log("Unrecognized Romanization method");
          //return;
        }
        while (!noDup(r)) {
          r += "_";
        }
        tokens[i][1] = r;
      }
      idenMap[key] = r;
    }
  }
}

function defaultLogCallback(x) {
  return typeof x == "string"
    ? console.log(x)
    : console.dir(x, { depth: null, maxArrayLength: null });
}

function defaultErrorCallback(e) {
  console.error(e);
  process.exit();
}

function tokens2asc(
  tokens: any[],
  assert = (msg, pos, b) => {
    if (!b) console.log(`ERROR@${pos}: ${msg}`);
  }
) {
  var asc: ASCNode[] = [];
  var i = 0;
  while (i < tokens.length) {
    var pos = gettok(i, 2);
    var cmd = gettok(i, 0);

    // @ts-ignore
    function gettok(idx: number, jdx: number) {
      if (tokens[idx] === undefined) {
        assert(`Unexpected EOF`, pos, false);
      }
      return tokens[idx][jdx] as string;
    }

    const typeassert = (idx: number, good, reason?: string) => {
      var typ = gettok(idx, 0);
      assert(
        `<${cmd}> Expecting ${good.join("/")}${
          reason ? " for " + reason : ""
        }, found ${typ}`,
        pos,
        good.includes(typ)
      );
    };

    if (
      gettok(i, 0) == "decl" &&
      (gettok(i, 1) == "uninit" || gettok(i, 1) == "public")
    ) {
      typeassert(i + 1, ["num"], "variable count");
      typeassert(i + 2, ["type"], "variable type");
      const cnt = Number(gettok(i + 1, 1));
      assert(
        `Invalid variable count ${cnt}`,
        pos,
        Number.isSafeInteger(cnt) && cnt > 0
      );

      var x: ASCNode = {
        op: "var",
        count: cnt,
        type: gettok(i + 2, 1),
        values: [],
        names: [],
        public: gettok(i, 1) == "public",
        pos
      };
      i += 3;
      while (tokens[i] && gettok(i, 0) == "assgn") {
        x.values.push(tokens[i + 1]);
        i += 2;
      }
      if (tokens[i] && gettok(i, 0) == "name") {
        x.names.push(gettok(i + 1, 1));
        i += 2;
      }
      while (tokens[i] && gettok(i, 0) == "assgn") {
        x.names.push(gettok(i + 1, 1));
        i += 2;
      }
      asc.push(x);
    } else if (gettok(i, 0) == "decl" && gettok(i, 1) == "init") {
      typeassert(i + 1, ["type"], "variable type");
      typeassert(
        i + 2,
        ["data", "num", "lit", "iden", "bool", "any"],
        "variable initialization"
      );

      var x: ASCNode = {
        op: "var",
        count: 1,
        type: gettok(i + 1, 1),
        values: [tokens[i + 2]],
        public: false,
        pos
      };
      i += 3;
      if (tokens[i] !== undefined && gettok(i, 0) == "name") {
        x.names = [gettok(i + 1, 1)];
        i += 2;
      }
      asc.push(x);
    } else if (gettok(i, 0) == "decl" && gettok(i, 1) == "prop") {
      typeassert(i + 1, ["lit"], "property key");
      typeassert(i + 3, ["type"], "property type");
      typeassert(i + 4, ["assgn"], "property value");
      var x: ASCNode = {
        op: "prop",
        type: gettok(i + 3, 1),
        name: tokens[i + 1][1],
        value: tokens[i + 5],
        pos
      };
      i += 6;
      asc.push(x);
    } else if (gettok(i, 0) == "print") {
      asc.push({ op: "print", pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "funstart") {
      var x: any = { op: "fun", arity: 0, args: [], pos };
      i++;
      if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "funarg") {
        i++;
        while (!(gettok(i, 0) == "ctrl" && gettok(i, 1) == "funbody")) {
          typeassert(i, ["num"], "argument count");
          typeassert(i + 1, ["type"], "argument type");
          var typ = gettok(i + 1, 1);
          var cnt = Number(gettok(i, 1));
          assert(
            `Invalid argument count ${cnt}.`,
            pos,
            Number.isSafeInteger(cnt) && cnt > 0
          );
          x.arity += cnt;
          i += 2;
          for (var j = 0; j < cnt; j++) {
            typeassert(i + j * 2, ["assgn"], "another argument");
            typeassert(i + j * 2 + 1, ["iden"], "argument");
            x.args.push({ name: tokens[i + j * 2 + 1][1], type: typ });
          }
          i += cnt * 2;
        }
      }
      asc.push(x);
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "funbody") {
      asc.push({ op: "funbody", pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "bigend") {
      assert(
        `<${cmd}> Incorrect function/object end`,
        pos,
        gettok(i + 2, 0) == "ctrl" && gettok(i + 1, 0) == "iden"
      );
      asc.push({ op: gettok(i + 2, 1), pos });
      i += 3;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "objbody") {
      asc.push({ op: "objbody", pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "if") {
      var x: ASCNode = { op: "if", test: [], pos };
      i++;
      while (!(gettok(i, 0) == "ctrl" && gettok(i, 1) == "conj")) {
        x.test.push(tokens[i]);
        i++;
      }
      i++;
      asc.push(x);
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "iftrue") {
      asc.push({ op: "if", test: [["ans"]], pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "iffalse") {
      asc.push({ op: "if", test: [["ans"]], not: true, pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "elseif") {
      var x: ASCNode = { op: "if", test: [], elseif: true, pos };
      i++;
      while (!(gettok(i, 0) == "ctrl" && gettok(i, 1) == "conj")) {
        x.test.push(tokens[i]);
        i++;
      }
      i++;
      asc.push(x);
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "end") {
      asc.push({ op: "end", pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "ret") {
      asc.push({ op: "return", value: tokens[i + 1], pos });
      i += 2;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "retprev") {
      asc.push({ op: "return", value: ["ans"], pos });
      i += 1;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "retvoid") {
      asc.push({ op: "return", pos });
      i += 1;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "break") {
      asc.push({ op: "break", pos });
      i += 1;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "continue") {
      asc.push({ op: "continue", pos });
      i += 1;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "else") {
      asc.push({ op: "else", pos });
      i += 1;
    } else if (gettok(i, 0) == "op") {
      typeassert(i + 2, ["opord"]);
      var x: ASCNode = { pos };
      if (gettok(i + 2, 1) == "l") {
        x.lhs = tokens[i + 1];
        x.rhs = tokens[i + 3];
      } else {
        x.lhs = tokens[i + 3];
        x.rhs = tokens[i + 1];
      }
      if (gettok(i, 1) == "/" && gettok(i + 4, 0) == "mod") {
        x.op = "op" + "%";
        i += 5;
      } else {
        x.op = "op" + gettok(i, 1);
        i += 4;
      }
      asc.push(x);
    } else if (gettok(i, 0) == "not") {
      asc.push({ op: "not", value: tokens[i + 1], pos });
      i += 2;
    } else if (gettok(i, 0) == "name") {
      typeassert(i + 1, ["iden"]);
      var x: ASCNode = { op: "name", names: [gettok(i + 1, 1)], pos };
      i += 2;
      while (tokens[i] && gettok(i, 0) == "assgn") {
        x.names.push(gettok(i + 1, 1));
        i += 2;
      }
      asc.push(x);
    } else if (gettok(i, 0) == "call" && gettok(i, 1) == "r") {
      var x: ASCNode = { op: "call", fun: tokens[i + 1], args: [], pos };
      i += 2;
      while (tokens[i] && gettok(i, 0) == "opord" && gettok(i, 1) == "r") {
        typeassert(i + 1, ["data", "num", "lit", "iden", "bool"]);
        x.args.push(tokens[i + 1]);
        i += 2;
      }
      asc.push(x);
    } else if (gettok(i, 0) == "call" && gettok(i, 1) == "l") {
      asc.push({ op: "call", pop: true, fun: tokens[i + 1], pos });
      i += 2;
    } else if (gettok(i, 0) == "ctnr" && gettok(i, 1) == "push") {
      typeassert(i + 2, ["opord"]);
      assert(`<${cmd}> Only opord l allowed`, pos, gettok(i + 2, 1) == "l");
      var x: ASCNode = {
        op: "push",
        container: tokens[i + 1],
        values: [tokens[i + 3]],
        pos
      };
      i += 4;
      while (tokens[i] && gettok(i, 0) == "opord" && gettok(i, 1) == "l") {
        x.values.push(tokens[i + 1]);
        i += 2;
      }
      asc.push(x);
    } else if (
      gettok(i, 0) == "expr" &&
      tokens[i + 2] &&
      gettok(i + 2, 0) == "ctnr" &&
      gettok(i + 2, 1) == "subs"
    ) {
      typeassert(i + 1, ["iden", "lit", "ans"]);
      var x: ASCNode = {
        op: "subscript",
        container: tokens[i + 1],
        value: tokens[i + 3],
        pos
      };
      asc.push(x);
      i += 4;
    } else if (
      gettok(i, 0) == "expr" &&
      tokens[i + 2] &&
      gettok(i + 2, 0) == "ctnr" &&
      gettok(i + 2, 1) == "len"
    ) {
      typeassert(i + 1, ["iden", "lit", "subs"]);
      var x: ASCNode = { op: "length", container: tokens[i + 1], pos };
      asc.push(x);
      i += 3;
    } else if (
      gettok(i, 0) == "expr" &&
      tokens[i + 3] &&
      gettok(i + 3, 0) == "lop"
    ) {
      var x: ASCNode = {
        op: "op" + gettok(i + 3, 1),
        lhs: tokens[i + 1],
        rhs: tokens[i + 2],
        pos
      };
      asc.push(x);
      i += 4;
    } else if (gettok(i, 0) == "expr") {
      asc.push({ op: "temp", iden: tokens[i + 1] });
      i += 2;
    } else if (gettok(i, 0) == "ctnr" && gettok(i, 1) == "cat") {
      var x: ASCNode = { op: "cat", containers: [tokens[i + 1]], pos };
      i += 2;
      while (gettok(i, 0) == "opord" && gettok(i, 1) == "l") {
        x.containers.push(tokens[i + 1]);
        i += 2;
      }
      asc.push(x);
    } else if (
      gettok(i, 0) == "ctrl" &&
      gettok(i, 1) == "for" &&
      gettok(i + 2, 0) == "ctrl" &&
      gettok(i + 2, 1) == "forin"
    ) {
      var x: ASCNode = {
        op: "for",
        container: tokens[i + 1],
        iterator: gettok(i + 3, 1),
        pos
      };
      i += 4;
      asc.push(x);
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "whiletrue") {
      asc.push({ op: "whiletrue", pos });
      i++;
    } else if (gettok(i, 0) == "ctrl" && gettok(i, 1) == "whilen0") {
      assert(
        `<${cmd}> Incorrect loop start`,
        pos,
        gettok(i + 2, 1) == "whilen1"
      );
      asc.push({ op: "whilen", value: tokens[i + 1], pos });
      i += 3;
    } else if (gettok(i, 0) == "rassgn" && gettok(i, 1) == "a") {
      var x: ASCNode = { op: "reassign", lhs: tokens[i + 1], pos };
      if (gettok(i + 2, 0) == "ctnr" && gettok(i + 2, 1) == "subs") {
        x.lhssubs = tokens[i + 3];
        if (gettok(i + 6, 0) == "rassgn" && gettok(i + 6, 1) == "delete") {
          x.rhs = undefined;
          x.del = true;
          i += 7;
        } else {
          x.rhs = tokens[i + 6];
          if (
            tokens[i + 7] &&
            gettok(i + 7, 0) == "ctnr" &&
            gettok(i + 7, 1) == "subs"
          ) {
            x.rhssubs = tokens[i + 8];
            i += 10;
          } else {
            i += 8;
          }
        }
      } else {
        assert(
          `<${cmd}> Missing conj`,
          pos,
          gettok(i + 2, 0) == "ctrl" && gettok(i + 2, 1) == "conj"
        );
        x.rhs = tokens[i + 4];
        if (
          tokens[i + 5] &&
          gettok(i + 5, 0) == "ctnr" &&
          gettok(i + 5, 1) == "subs"
        ) {
          x.rhssubs = tokens[i + 6];
          i += 8;
        } else {
          i += 6;
        }
      }
      asc.push(x);
    } else if (gettok(i, 0) == "discard") {
      asc.push({ op: "discard", pos });
      i++;
    } else if (gettok(i, 0) == "take") {
      typeassert(i + 1, ["num"], "argument count");
      const cnt = Number(gettok(i + 1, 1));
      assert(
        `Invalid argument count ${cnt}`,
        pos,
        Number.isSafeInteger(cnt) && cnt > 0
      );
      asc.push({ op: "take", count: cnt, pos });
      i += 2;
    } else if (gettok(i, 0) == "import" && gettok(i, 1) == "file") {
      var x: ASCNode = { op: "import", file: gettok(i + 1, 1), iden: [], pos };
      i += 2;
      while (gettok(i, 0) == "import" && gettok(i, 1) == "in") {
        x.file += "/" + gettok(i + 1, 1);
        i += 2;
      }
      i += 1;
      if (tokens[i] && gettok(i, 0) == "import" && gettok(i, 1) == "iden") {
        i++;
        while (!(gettok(i, 0) == "import" && gettok(i, 1) == "idenend")) {
          typeassert(i, ["iden"]);
          x.iden.push(gettok(i, 1));
          i++;
        }
        i++;
      }
      asc.push(x);
    } else if (gettok(i, 0) == "try" && gettok(i, 1) == "try") {
      asc.push({ op: "try", pos });
      i++;
    } else if (gettok(i, 0) == "try" && gettok(i, 1) == "catch") {
      asc.push({ op: "catch", pos });
      i++;
    } else if (gettok(i, 0) == "try" && gettok(i, 1) == "catcherr0") {
      typeassert(i + 2, ["try"]);
      asc.push({ op: "catcherr", error: tokens[i + 1], pos });
      i += 3;
    } else if (gettok(i, 0) == "try" && gettok(i, 1) == "catchall") {
      asc.push({ op: "catcherr", error: undefined, pos });
      i++;
    } else if (gettok(i, 0) == "try" && gettok(i, 1) == "end") {
      asc.push({ op: "tryend", pos });
      i++;
    } else if (gettok(i, 0) == "throw" && gettok(i, 1) == "a") {
      typeassert(i + 2, ["throw"]);
      asc.push({ op: "throw", error: tokens[i + 1], pos });
      i += 3;
    } else if (gettok(i, 0) == "comment") {
      asc.push({ op: "comment", value: tokens[i + 1], pos });
      i += 2;
    } else if (gettok(i, 0) == "macro") {
      i += 2;
    } else {
      //console.log("Unrecognized",tokens[i])
      i++;
    }
  }

  return asc;
}

function jsWrapModule(name, src) {
  var splitted = name.split("/");
  var bname = splitted[splitted.length - 1];
  return `/*___wenyan_module_${name}_start___*/var ${bname} = new function(){ ${src} };/*___wenyan_module_${name}_end___*/`;
}
function pyWrapModule(name, src) {
  // return `#/*___wenyan_module_${name}_start___*/\nclass ${name}:\n${src.split("\n").map(x=>"\t"+x).join("\n")}\n#/*___wenyan_module_${name}_end___*/\n`;
  return `#/*___wenyan_module_${name}_start___*/\n${src}\n#/*___wenyan_module_${name}_end___*/\n`;
}

function compile(txt: string, options?: Partial<CompileOptions>): string {
  const {
    lang = "js",
    romanizeIdentifiers = "none",
    resetVarCnt = true,
    logCallback = defaultLogCallback,
    errorCallback = defaultErrorCallback,
    lib = STDLIB,
    strict = false,

    // import options
    entryFilepath = undefined,
    importPaths = [],
    importCache = {},
    importContext = {},
    allowHttp = false,
    trustedHosts = [],
    requestTimeout = 2000
  } = options;

  trustedHosts.push(...defaultTrustedHosts);

  const reader = importReader;

  const importOptions = {
    entryFilepath,
    importPaths,
    importCache,
    importContext,
    allowHttp,
    trustedHosts,
    requestTimeout
  };

  if (resetVarCnt) idenMap = {};
  txt = (txt || "").replace(/\r\n/g, "\n");

  var txtlines = txt.split("\n");
  function assert(msg, pos, b) {
    var errmsg = "";
    if (!b) {
      errmsg += `[Syntax Error] ${msg}\n`;
      var l = 0;
      for (var i = 0; i < txtlines.length; i++) {
        l += txtlines[i].length + 1;
        if (l > pos) {
          errmsg += `Line ${1 + i}, Character ${1 +
            pos -
            (l - txtlines[i].length)}:${txtlines[i]}`;
          break;
        }
      }
      logCallback(errmsg);
    }
    if (errmsg.length) {
      if (errorCallback) {
        errorCallback(errmsg);
      }
      return errmsg;
    }
    return 0;
  }

  var macros = extractMacros(txt, {
    lib,
    lang,
    importOptions
  });
  txt = expandMacros(txt, macros);

  logCallback("\n\n=== [PASS 0] EXPAND-MACROS ===");
  logCallback(macros);
  // logCallback(txt);

  var tokens = wy2tokens(txt, assert);

  logCallback("\n\n=== [PASS 1] TOKENIZER ===");
  logCallback(tokens);

  if (romanizeIdentifiers != "none") {
    tokenRomanize(tokens, romanizeIdentifiers);
  }

  var asc = tokens2asc(tokens, assert);

  logCallback("\n\n=== [PASS 2] ABSTRACT SYNTAX CHAIN ===");
  logCallback(asc);

  if (strict) {
    logCallback("\n\n=== [PASS 2.5] TYPECHECK ===");
    logCallback(printSignature(typecheck(asc, assert)));
  }

  logCallback("\n\n=== [PASS 3] COMPILER ===");
  var mwrapper = { js: jsWrapModule, py: pyWrapModule, rb: x => x }[lang];
  if (!transpilers[lang]) {
    console.log(transpilers);
    new Error("Target language not supported.");
  }
  var transpiler = new transpilers[lang](asc);
  var { imports, result } = transpiler.transpile({ imports });
  var targ = result;
  logCallback(targ);
  imports = imports || [];
  imports = Array.from(new Set(imports));
  logCallback("Loading imports", imports);
  for (var i = 0; i < imports.length; i++) {
    var isrc, entry;
    if (imports[i] in lib[lang]) {
      isrc = lib[lang][imports[i]];
    } else if (imports[i] in lib) {
      isrc = lib[imports[i]];
    } else {
      const file = reader(imports[i], importOptions);
      isrc = file.src;
      entry = file.entry;
    }
    targ =
      mwrapper(
        imports[i],
        compile(isrc, {
          ...options,
          entryFilepath: entry,
          resetVarCnt: false,
          strict: false
        })
      ) + targ;
  }

  return targ;
}

function isLangSupportedForEval(lang) {
  if (lang !== "js")
    throw new Error(
      `Executing for target language "${lang}" is not supported in current environment`
    );
  return true;
}

function hanzinize(value) {
  if (typeof value == "number") {
    return num2hanzi(value);
  } else if (typeof value == "boolean") {
    return bool2hanzi(value);
  } else if (Array.isArray(value)) {
    return value.map(i => hanzinize(i)).join("。");
  } else {
    return value;
  }
}

function outputHanziWrapper(log: LogCallback, outputHanzi: boolean) {
  return function output(...args) {
    log(...args.map(i => (outputHanzi ? hanzinize(i) : i)));
  };
}

function evalCompiled(
  compiledCode: string,
  options: Partial<ExecuteOptions> = {}
) {
  const {
    outputHanzi = true,
    scoped = false,
    lang = "js",
    output = console.log
  } = options;

  isLangSupportedForEval(lang);

  let code = compiledCode;

  (() => {
    const _console_log = console.log;
    console.log = outputHanziWrapper(output, outputHanzi);
    try {
      if (!scoped && "window" in this) {
        window.eval(code);
      } else {
        eval(code);
      }
    } catch (e) {
      throw e;
    } finally {
      console.log = _console_log;
    }
  })();
}

function execute(
  source: string,
  options: Partial<ExecuteOptions & CompileOptions> = {}
) {
  const { lang = "js" } = options;
  isLangSupportedForEval(lang);
  const compiled = compile(source, options);
  evalCompiled(compiled, options);
}

export {
  compile,
  evalCompiled,
  execute,
  version,
  wy2tokens,
  tokens2asc,
  hanzi2num,
  hanzi2numstr,
  num2hanzi,
  bool2hanzi,
  hanzi2pinyin,
  KEYWORDS,
  NUMBER_KEYWORDS,
  STDLIB
};
