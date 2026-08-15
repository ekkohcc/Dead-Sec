// blessed-emoji-patch.cjs
//
// blessed 0.1.81 的宽字符表不包含 0x1F000+ 码点(emoji / 星面字符),
// 所有 emoji 一律按宽度 1 计算,而真实终端按宽度 2 渲染。
// 后果:
//   1. blessed 做 diff 重绘(定位 + 片段重写)时列位置偏移 1 列,
//      会覆盖相邻空格,例如提示行 "💡 复制" 被重绘成 "💡复制"。
//   2. 即使把宽度修正为 2,parseContent 的正则 chars.all 也不含
//      0x1F000-0x1FFFF(高代理 \ud83c-\ud83e),渲染循环会执行
//      "eat the next char",把 emoji 后的真实空格吞掉。
//
// 因此补丁做两件事(在 blessed 渲染前执行):
//   a. 星面码点按宽度 2 计算(补充平面变体选择符 U+E0100–U+E01EF
//      为零宽,需排除)。
//   b. 把 emoji 代理对范围并入 unicode.chars.all,使 parseContent
//      在 emoji 后插入占位符 \x03,渲染时吃掉的是占位符而非真实空格。

const unicode = require("blessed/lib/unicode");

if (typeof unicode.charWidth === "function") {
  const originalCharWidth = unicode.charWidth.bind(unicode);

  unicode.charWidth = function (str, i) {
    const point =
      typeof str !== "number" ? unicode.codePointAt(str, i || 0) : str;
    if (point > 0xffff && point <= 0x10fffd) {
      if (point >= 0xe0100 && point <= 0xe01ef) return 0; // VS supplement
      return 2;
    }
    return originalCharWidth(str, i);
  };
}

if (unicode.chars && unicode.chars.all && unicode.chars.swide) {
  // 0x1F000-0x1FFFF: 高代理 \ud83c-\ud83e × 低代理 \udc00-\udfff
  const emojiPair = "[\\ud83c-\\ud83e][\\udc00-\\udfff]";
  const swideSrc = unicode.chars.swide.source.slice(1, -1);
  unicode.chars.swide = new RegExp("(" + emojiPair + "|" + swideSrc + ")", "g");
  unicode.chars.all = new RegExp("(" + emojiPair + "|" + swideSrc + "|" + unicode.chars.wide.source.slice(1, -1) + ")", "g");
}
