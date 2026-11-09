"""Vehicle name matching for the shop's sunshade table (vehicle_lookup_v2).

Ported from the shop's offline test bench. It decides only which table rows a buyer's
words name and what to ask next; it never approves fitment by itself and reads nothing
but the records and the word lists it is given.
"""
import json
from pathlib import Path
import re
import unicodedata

MAX_LIMIT = 5
# Brand tokens a caller may state alongside the model; a brand alone never selects rows.
BRANDS = ("本田", "丰田", "大众", "日产", "别克", "雪佛兰", "福特", "现代", "起亚", "马自达",
          "奥迪", "宝马", "奔驰", "比亚迪", "吉利", "长安", "奇瑞", "传祺", "哈弗", "长城",
          "五菱", "宝骏", "雷克萨斯", "沃尔沃", "凯迪拉克", "林肯", "特斯拉", "蔚来", "小鹏", "理想", "纳智捷")
NON_BRAND_DIRECTORIES = ("其他", "未分类", "测试")
# A group brand a buyer says for its sub-brands' cars ("长城猛龙" is 哈弗猛龙, "东风风神" is 风神).
PARENT_BRANDS = {"长城": ("哈弗", "魏牌", "欧拉", "坦克"),
                 "东风": ("风神", "风行", "启辰", "岚图", "日产", "本田", "标致", "雪铁龙", "奕派"),
                 "比亚迪": ("腾势", "方程豹", "仰望"), "长安": ("深蓝", "启源", "阿维塔", "欧尚"),
                 "吉利": ("领克", "极氪", "几何"), "北汽": ("北京", "极狐"), "奇瑞": ("星途", "捷途")}
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
YEAR_RANGE = re.compile(r"(?<![a-z0-9])\d{2,4}\s*(?:年款|款|年)?\s*[-—–~～至到]\s*\d{2,4}\s*(?:年款|款|年)?", re.I)
SINGLE_YEAR = re.compile(r"(?<![a-z0-9])\d{2,4}\s*(?:年款|款|年)")
GLUED_YEAR = re.compile(r"(?<![a-z0-9])(?:19|20)\d{2}(?![a-z0-9])")
BRACKETS = re.compile(r"【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)|<[^>]*>")
STRAY_BRACKET = re.compile(r"^[^【\[(<]*?[】\])>]|[【\[(<][^】\])>]*$")
QUALIFIERS = re.compile(r"国产|进口|新|老")
SPACES = re.compile(r"\s+")
DIGITS = {"0": 0, "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
          "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
CN_NUM = "零〇一二两三四五六七八九十"
# "十代" / "10代" / "十一代" / "11代"; a bounded numeral before 代, never inside an ASCII identifier.
GENERATION = re.compile(r"(?<![a-z0-9])(\d{1,2}|[" + CN_NUM + r"]{1,3})代")
LETTER_HYPHEN = re.compile(r"(?<=[a-z])[-‐－](?=[a-z])")
CODE_NUMERAL = re.compile(r"(?<=[a-z])[一二三四五六七八九](?![一二三四五六七八九十代驱座门])|[一二三四五六七八九](?=系)")
DISPLACEMENT = re.compile(r"(?<![0-9])\d\.\d\s*[lt]?(?![a-z0-9])")  # "1.5t" / "2.0" is the engine, not the car
GLUED_TRIM = re.compile(r"(?<=[a-z0-9])\s+(?=(?:plus|pro|max|ultra)(?![a-z0-9]))")  # "cs75 plus" == "cs75plus"
# Spoken filler around a car name in a buyer's sentence ("有26款问界M7吗", "我的车是卡罗拉的"). Only the
# query is cleaned; table names are never touched. None of these is part of a car name in the table.
FILLER = re.compile(r"车子|车窗户|车窗|窗户|天窗|有没有|有木有|有没|有吗|有么|有嘛|能不能用|可不可以用|能用吗|能用么|能用不|可以用吗|可以用么|"
                    r"可以使用吗|可以用|能用|可以|适用于|适用|适合|请问|你好|您好|我的车型是|我的车型|我的车是|我的车|"
                    r"我的是|车型是|车型|这款|这个|的吗|吗|么|嘛|呢|吧|呀|啊|哦|的|是|有|亲|第|我|车|买的|"
                    # what the buyer wants for the car, never part of its name
                    r"遮阳帘|遮阳挡|遮阳板|遮阳|车帘|挡帘|前挡风|后挡风|风挡|前挡|后挡|后档|前档|前窗|后窗|侧窗|小窗|三角窗|"
                    r"玻璃|全车|一套|多少钱|合适|款")
# A code typed with a space ("cs 75", "gs 7", "q 5"); never a year or a range ("途观l 17-23", "es 26款").
SPACED_CODE = re.compile(r"(?<![a-z0-9])([a-z]{2,3}(?=\s+\d{1,2}(?!\d))|[a-z](?=\s+\d(?!\d)))\s+(\d{1,2})(?![\d.\-])(?!\s*[年款座])")
SEATS = re.compile(r"\s*大?(?<!\d)([5-9五六七八九])\s*座")  # "大五座" is seats too, not a car "大"
SEAT_DIGITS = str.maketrans("五六七八九", "56789")
SEAT_OF = re.compile(r"(?<!\d)([5-9])座")  # on normalised text
# Traditional characters buyers type ("豐田", "軒逸", "納智捷"): one-to-one to simplified, on both sides of a match.
_TRADITIONAL = ("車车轎轿軒轩豐丰寶宝馬马東东風风長长奧奥標标緻致鐵铁達达鈴铃謳讴紅红產产現现納纳鴻鸿華华號号"
                "雙双動动電电驅驱門门廂厢後后擋挡檔档簾帘陽阳價价錢钱嗎吗麼么這这個个樣样適适帶带謝谢請请問问們们"
                "還还買买賣卖單单備备註注進进國国灣湾漢汉蘭兰凱凯羅罗銳锐鋭锐騏骐驪骊頓顿傳传啟启啓启榮荣億亿聯联"
                "來来極极嵐岚圖图領领寧宁紳绅勝胜邁迈騰腾薩萨駿骏誌志閣阁飛飞鋒锋範范歐欧藍蓝雲云賽赛澤泽爾尔維维"
                "亞亚輝辉貨货幾几對对錯错過过開开關关賓宾塊块種种體体邊边裡里裏里點点換换讓让給给歲岁舊旧寬宽遠远"
                "樂乐愛爱誠诚際际龍龙鳳凤獅狮詩诗韻韵楓枫馳驰瑪玛蓮莲帥帅歡欢為为時时選选擇择見见說说話话證证實实"
                "視视線线總总計计黃黄綠绿銀银鋁铝轉转輪轮輛辆駕驾駛驶廣广蘇苏慶庆陸陆區区興兴業业遙遥創创優优鉑铂"
                "揚扬瀾澜獵猎鷹鹰熱热臺台發发復复")
TRADITIONAL = str.maketrans(dict(zip(_TRADITIONAL[::2], _TRADITIONAL[1::2])))
ALIASES_PATH = Path(__file__).resolve().parent / "vehicle_aliases.json"
MAX_ALIASES = 500
# A buyer's word naming a table car plus extra trim ("哈弗h6运动版" -> "哈弗h6") is that car; table words
# shorter than this, or these generic words, are never taken out of a buyer's word.
MIN_CONTAINED = 2
GENERIC_TOKENS = {"新能源", "混动", "燃油", "纯电", "插混", "增程", "三厢", "两厢", "老款", "新款", "进口", "国产",
                  "专用", "旅行款", "旅行版", "商务车", "suv", "mpv", "plus", "pro", "max", "ultra", "ev", "dmi", "dm",
                  "phev", "hev", "公务舱", "顶配", "低配", "高配", "版", "model", "之前", "之后", "以前", "以后",
                  "同款", "停售", "经典", "经典款", "升级版", "运动版", "加长版", "长轴", "短轴", "标轴", "七座", "五座", "六座",
                  "5座", "6座", "7座", "8座", "9座",
                  "运动", "通用", "能源", "豪华", "豪华版", "尊贵版", "舒适版", "精英版", "智享版", "领先版"}
# Powertrain codes that may follow a car word without making it another car ("宋prodmi" is a 宋pro). Not plus / pro /
# max: "宋plus" and "宋pro" are different cars.
TRIM_SUFFIXES = {"dmi", "dm", "dmp", "ev", "phev", "hev", "edm"}
TRIM_TAIL = re.compile(r"(.+?)(?:" + "|".join(sorted(TRIM_SUFFIXES, key=len, reverse=True)) + ")")
# Typo tolerance: one edit (substitution / insertion / deletion / swap) on a name at least this long, inside a run of
# 4+ letters or 3+ Chinese characters; shorter slips ("哈佛", "领跑") come from the shop's typo list instead.
MIN_SIMILAR = 3


class CatalogError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)  # Never the source text or a local path.


def _require(condition, code):
    if not condition:
        raise CatalogError(code)


# ---------------------------------------------------------------- normalisation

def _cn_number(text):
    """0-99 in the ten/unit form the table uses: 十=10, 十一=11, 二十=20, 十六=16, 3=3."""
    if text.isdigit():
        return int(text)
    if not text or any(c not in CN_NUM for c in text) or text.count("十") > 1:
        return None
    if "十" not in text:
        return DIGITS[text] if len(text) == 1 else None
    tens, ones = text.split("十")
    if len(tens) > 1 or len(ones) > 1:
        return None
    return (1 if not tens else DIGITS[tens]) * 10 + (0 if not ones else DIGITS[ones])


def _canonical_generations(text):
    """Both sides of a match are canonicalised ("十一代" and "11代" -> "11代"); 十一 is never 1."""
    return GENERATION.sub(lambda m: (str(v) + "代") if (v := _cn_number(m[1])) is not None else m[0], text)


def _normalize(text):
    text = unicodedata.normalize("NFKC", text).casefold().translate(TRADITIONAL)
    text = LETTER_HYPHEN.sub("", text)  # "cr-v" -> "crv", same on both sides
    text = GLUED_TRIM.sub("", text)
    text = re.sub(r"(?<=\d)\s+(?=系)", "", text)  # "3 系" -> "3系"
    # "汉兰达7座" -> "汉兰达 7座", "7 座" / "七座" -> "7座": seats, a trim; "7座旅行版" -> "7座 旅行版"
    text = SEATS.sub(lambda m: " " + m[1].translate(SEAT_DIGITS) + "座 ", text)
    text = SPACED_CODE.sub(r"\1\2", text)  # "cs 75" -> "cs75", "q 5" -> "q5"
    return SPACES.sub(" ", _canonical_generations(text)).strip()


def _generation_of(name):
    found = GENERATION.search(name)
    return _cn_number(found[1]) if found else None


def _full_year(value, length):
    number = int(value)
    return number if length >= 4 else (2000 if number <= 50 else 1900) + number


def _year_hint(text):
    """(low, high) for the first explicit year mention in text; None when the text states none.

    Text is matched as written (not casefolded) so the negative lookbehind sees the original.
    """
    raw = SPACES.sub(" ", unicodedata.normalize("NFKC", text)).strip()
    for match in YEAR_RANGE.finditer(raw):
        start, end = re.findall(r"\d{2,4}", match[0])
        return min(_full_year(start, len(start)), _full_year(end, len(end))), \
            max(_full_year(start, len(start)), _full_year(end, len(end)))
    for match in SINGLE_YEAR.finditer(raw):
        year = re.match(r"\d{2,4}", match[0])[0]
        return _full_year(year, len(year)), _full_year(year, len(year))
    # A bare 4-digit year glued to the car name ("思域2018"): only 4 digits, never a 2-digit
    # suffix that could be part of a model code.
    for match in GLUED_YEAR.finditer(raw):
        return _full_year(match[0], 4), _full_year(match[0], 4)
    return None


def _record_years(part):
    return _year_hint(part)


def _query_year(query):
    """The year a query text states ("2018年" / "18-20款" / "猛龙plus2026" / "2014q5l"); None otherwise."""
    found = _year_hint(query)
    if found is None and (glued := LETTER_YEAR.search(_normalize(query))):
        year = _full_year(glued[0], len(glued[0]))
        return year, year
    return found


# A 4-digit year glued to a model code in a buyer's query ("plus2026", "2014q5l"); query side only.
LETTER_YEAR = re.compile(r"(?<=[a-z])(?:19|20)\d{2}(?![0-9])|(?<![0-9a-z])(?:19|20)\d{2}(?=[a-z])"
                         r"|(?<=[a-z]{3})\d{2}(?=\s*(?:年款|款|年))")  # "crv21款"; not "cs75款"


def _edit1(a, b):
    """True when a and b differ by exactly one substitution, insertion, deletion or adjacent swap."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1
                                  and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


def _typo(word, token):
    """One slip of the pen ("汉兰大"/"汉兰达", "puls"/"plus"), never a different number, letter code or one-character
    model: "s3"/"s5", "x80pro"/"x90pro", "a200"/"e200", "五系"/"1系" and "汉lev"/"宋lev" are other cars, not typos."""
    if not _edit1(word, token):
        return False
    i = 0
    while i < min(len(word), len(token)) and word[i] == token[i]:
        i += 1
    for text in (word, token):
        char = text[i:i + 1]
        if not char:
            continue
        if char.isdigit() or char in CN_NUM:
            return False
        # The run of the same script around the slip: 4+ letters ("plus"), or 3+ Chinese characters ("汉兰达").
        same = (lambda c: c.isascii() and c.isalpha()) if char.isascii() else (lambda c: not c.isascii())
        start, end = i, i + 1
        while start > 0 and same(text[start - 1]):
            start -= 1
        while end < len(text) and same(text[end]):
            end += 1
        if end - start < (4 if char.isascii() else 3):
            return False
    return True


def load_aliases(path=ALIASES_PATH):
    """The shop's own word lists: {"aliases": {"霸道": "普拉多"}, "typos": {"哈佛": "哈弗"},
    "handoff": {"吉姆尼 5门": "表里只有07-18款吉姆尼"}}. An alias is the same car under another name and is searched as
    the table name; a typo is searched too, but only ever reported as similar for the buyer to confirm; a handoff entry
    (words that must all appear in the query) is a car a person has to check, never answered from the table.
    Missing file: no lists. A malformed file is an error, never silently ignored."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"aliases": {}, "typos": {}, "handoff": {}}
    except (OSError, UnicodeError, ValueError):
        raise CatalogError("invalid_aliases") from None
    _require(isinstance(data, dict), "invalid_aliases")
    result = {}
    for kind in ("aliases", "typos", "handoff"):
        entries = data.get(kind, {})
        _require(isinstance(entries, dict) and len(entries) <= MAX_ALIASES, "invalid_aliases")
        result[kind] = {}
        for alias, name in entries.items():
            _require(isinstance(name, str) and 0 < len(alias) <= 40 and 0 < len(name) <= 40
                     and not CONTROL.search(alias + name), "invalid_aliases")
            result[kind][_normalize(alias)] = _normalize(name)
    return result


def _name_key(part):
    """Search key of one model name. The original name stays in the result."""
    key = BRACKETS.sub(" ", part)
    key = YEAR_RANGE.sub(" ", key)
    key = SINGLE_YEAR.sub(" ", key)
    key = GLUED_YEAR.sub(" ", key)
    key = QUALIFIERS.sub(" ", key)
    return SPACES.sub(" ", key).strip()


def _segments(text):
    """Structured split of a query: car words and the generations it states.

    A generation glued to the car name ("思域十代", "10代思域", "本田思域10代") separates into the
    car word ("思域") plus a generation. A glued brand ("本田思域") is kept as an inline word and
    also tried as brand + remainder ("思域"), so a brand never hides the car.
    """
    text = _name_key(_normalize(text)) or _normalize(text)
    text = SPACES.sub(" ", FILLER.sub(" ", LETTER_YEAR.sub(" ", DISPLACEMENT.sub(" ", text)))).strip()
    # A spoken digit inside a model code: "nx八" -> "nx8", "h九" -> "h9", "五系" -> "5系".
    text = CODE_NUMERAL.sub(lambda m: str(DIGITS[m[0]]), text)
    if re.fullmatch(r"[a-z]{1,4} [a-z]", text):
        text = text.replace(" ", "")  # "cr v" is the model code "crv"
    words, generations = [], set()
    chunks = [chunk for chunk in re.split(r"[\s，。？！、,.?!;；:：/|~～()（）\[\]【】<>《》\"'“”‘’+\-]+", text) if chunk]
    for chunk in chunks:
        for found in GENERATION.finditer(chunk):
            value = _cn_number(found[1])
            if value is not None:
                generations.add(value)
        rest = GENERATION.sub(" ", chunk) if GENERATION.search(chunk) else chunk
        rest = SPACES.sub(" ", rest).strip()
        for word in rest.split():
            if not word:
                continue
            words.append(word)
            for brand in BRANDS:
                if word != brand and word.startswith(brand) and len(word) > len(brand):
                    # "本田思域" -> "本田 思域"; the remainder is a model word in its own right.
                    words += [brand, word[len(brand):]]
    return words, generations


NEAR_GAP = 2  # a stated year at most this far from a row is most likely that row (换代年份前后差一两年)


def _hint(status, candidates, years, generations, nearest=None, similar=None, seats=None, brand_conflict=None):
    """One always-string sentence for the model: what the table has, so a near miss becomes a concrete
    question ("表里有 22-25款 问界M7、26款 问界m7") instead of "请确认年份"."""
    names = "、".join(c["model"].strip() for c in candidates)
    asked = "、".join([f"{y}年" for y in sorted(set(years or ()))] + [f"{g}代" for g in sorted(generations)])
    if status == "similar":
        said, names_like = similar
        ask = f"只问买家是不是{names_like[0]}" if len(names_like) == 1 else f"问买家是{'还是'.join(names_like)}"
        return (f"表里没有和买家说的“{said}”完全一致的车名，相近的是“{'、'.join(names_like)}”（相似待确认，不算命中），"
                f"表里对应的行：{names}。{ask}，买家确认后用表里写法重新查询")
    if status == "year_mismatch":
        text = f"买家说的{asked}不在表内年款/代次范围；表里这款车有：{names}。"
        if nearest and nearest["gap"] <= NEAR_GAP:
            return text + (f"最接近的是“{nearest['row']['model'].strip()}”，只差{nearest['gap']}{nearest['unit']}："
                           "只问买家是不是这一款，不要列出全部选项")
        return text + "请列出这些选项让买家确认是哪一款"
    if status == "needs_year":
        return f"表里按年款/代次区分：{names}。请列出这些选项问买家是哪一款"
    if status == "needs_model" and brand_conflict:
        return (f"买家说的是“{brand_conflict}”，表里没有这个品牌的这款车；名称相同的是其他品牌的：{names}。"
                f"先说表里没有{brand_conflict}，再问买家是不是其中一款")
    if status == "needs_model" and seats:
        return f"表里按座数区分：{names}。只问买家是{'还是'.join(s + '座' for s in seats)}"
    if status == "needs_model":
        return f"名称对应多款不同的车：{names}。请列出这些选项问买家是哪一款"
    if status in ("matched", "ambiguous"):
        return f"表内匹配：{names}"
    if brand_conflict:
        return f"表里没有“{brand_conflict}”（同名的只有其他品牌的车，不是这款）：车名清楚，直接简短说明这款暂时没有，不要追问"
    return "表里没有这个车名：买家车名清楚完整就简短说明这款暂时没有，不完整或像打错字才请买家确认一次车名"


# ---------------------------------------------------------------- retrieval

class Catalog:
    def __init__(self, records, aliases=None):
        """records: {record_id, family, model, directory}; directory is the brand folder of the table."""
        self.records = tuple(records)
        lists = aliases or {}
        self.aliases = {**lists.get("typos", {}), **lists.get("aliases", {})}
        self.typos = set(lists.get("typos", {})) - set(lists.get("aliases", {}))
        self.handoff = [(tuple(words.split()), reason) for words, reason in lists.get("handoff", {}).items()]
        self._alias_pattern = re.compile("|".join(
            # A code end is never cut out of a longer code: "奔驰e300" is not in "奔驰e300l".
            (r"(?<![a-z0-9])" if alias[0].isascii() and alias[0].isalnum() else "") + re.escape(alias)
            + (r"(?![a-z0-9])" if alias[-1].isascii() and alias[-1].isalnum() else "")
            for alias in sorted(self.aliases, key=len, reverse=True))) if self.aliases else None
        self._prepared = []
        for index, record in enumerate(self.records):
            names = []
            for part in re.split(r"[/、,，;；]", record["model"]):
                if not part.strip():
                    continue
                # "【提供车架号、车侧面照】26款速腾s" split at 、: the halves of the bracket are notes, not the name.
                text = _name_key(STRAY_BRACKET.sub(" ", _normalize(part)))
                if not text:
                    continue
                names.append({"text": text, "generation": _generation_of(text),
                              "years": _record_years(part)})
            self._prepared.append({"index": index, "names": names, "family": _normalize(record["family"]),
                                   "directory": _normalize(record["directory"])})
        # A brand / series directory ("问界", "本田") names no single car: a query of only such words
        # must ask which model, never count as a match.
        self.brands = {_normalize(b) for b in BRANDS} | {
            item["directory"] for item in self._prepared if item["directory"] not in NON_BRAND_DIRECTORIES}
        # Car words of the table ("汉兰达", "哈弗h6", "gl8"), for a buyer word with extra trim or a typo.
        self.tokens = set()
        for item in self._prepared:
            for name in item["names"]:
                for token in re.split(r"[\s，。？！、,.?!;；:：/|~～()（）\[\]【】<>《》\"'“”‘’+\-]+",
                                      GENERATION.sub(" ", name["text"])):
                    # "aion埃安s" is also "埃安s": a Latin prefix before a Chinese name is the maker's label.
                    for variant in {token, re.sub(r"^[a-z0-9]+(?=[^\x00-\x7f])", "", token)}:
                        if (len(variant) >= MIN_CONTAINED and not variant.isdigit() and variant not in self.brands
                                and variant not in GENERIC_TOKENS):
                            self.tokens.add(variant)

    def _apply_aliases(self, text):
        if not self._alias_pattern:
            return text, []
        used = []

        def swap(match):
            used.append((match[0], self.aliases[match[0]], match[0] in self.typos))
            return self.aliases[match[0]]
        return SPACES.sub(" ", self._alias_pattern.sub(swap, text)).strip(), used

    def _contained(self, word, loose=False):
        """The table car words inside a buyer word, longest first and not overlapping ("哈弗h6运动版" -> ["哈弗h6"],
        "卡罗拉双擎e" -> ["卡罗拉", "双擎e"]). A code may not run on into more letters or digits ("x5" is not in "x50",
        "星光" is not "星光l"), except a generic trim ("宋plusdmi") or a year ("18哈弗h5", "猛龙2026"). With loose,
        it may ("艾瑞泽8pro" -> "艾瑞泽8"): only ever a similar car for the buyer to confirm, never a match."""
        found = []
        for token in sorted(self.tokens, key=lambda t: (-len(t), t)):
            start = word.find(token)
            while start >= 0:
                end = start + len(token)
                before = re.search(r"[a-z0-9]*$", word[:start])[0]
                after = re.match(r"[a-z0-9]*", word[end:])[0]
                # Even loose, a code is never cut out of a longer code: "rv" is not in "zrv", "c2" is not in "c200l".
                if ((not before or before.isdigit())
                        and (not after or after in TRIM_SUFFIXES or re.fullmatch(r"(?:19|20)\d\d", after)
                             or (loose and not (after[0].isdigit() and token[-1].isdigit())))
                        and all(end <= s or start >= e for s, e, _ in found)):
                    found.append((start, end, token))
                    break
                start = word.find(token, start + 1)
        return [token for _, _, token in sorted(found)]

    def _similar(self, word):
        """Table car words one typo away from a buyer word ("汉兰大" -> "汉兰达", "元puls" -> "元plus")."""
        if len(word) < MIN_SIMILAR:
            return []
        return sorted(token for token in self.tokens if len(token) >= MIN_SIMILAR and _typo(word, token))[:3]

    def _any_hit(self, word):
        return any(self._hit(word, item) for item in self._prepared)

    @staticmethod
    def _model_key(word, text):
        """The model token a word names inside a model name: "问界" in "问界m8" is "问界m8", "宋" in
        "宋lev" is "宋lev", while "思域" in "11代思域三厢" stays "思域" (body style, same car)."""
        if word.isascii():
            return word
        text = GENERATION.sub(" ", text)  # "雅阁11代": a generation of 雅阁, not a model "雅阁11"
        start = text.find(word)
        if start < 0:
            return word
        end = start + len(word)
        while end < len(text) and text[end].isascii() and text[end].isalnum():
            end += 1
        while word[0].isascii() and start > 0 and text[start - 1].isascii() and text[start - 1].isalnum():
            start -= 1  # never for a Chinese-led word: "埃安s" in "aion埃安s" is "埃安s"
        return text[start:end]

    def _row_models(self, words, item):
        keys = set()
        for word in words:
            if word in BRANDS:
                continue
            for name in item["names"]:
                if self._hit(word, {"names": [name]}):
                    keys.add(self._model_key(word, name["text"]))
        return item["directory"], frozenset(keys)

    def _names_exactly(self, words, item):
        """A row whose model is exactly a buyer word: "途昂" in "途昂", not "途昂x"; "奔腾" is not "奔腾小马";
        "思域" in "思域三厢" is (body style, same car)."""
        for word in words:
            if word in BRANDS:
                continue
            for name in item["names"]:
                text = GENERATION.sub(" ", name["text"])
                start = text.find(word)
                if start < 0 or self._model_key(word, name["text"]) != word:
                    continue
                rest = re.match(r"[一-鿿]*", text[start + len(word):])[0]
                if not rest or rest in GENERIC_TOKENS:
                    return True
        return False

    def _hit(self, keyword, item):
        for name in item["names"]:
            for word in keyword.split() if keyword.strip() else ():
                text = name["text"]
                if word.isascii():
                    if not re.search(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", text):
                        break
                elif len(word) == 1:
                    # A one-character car ("汉", "宋") is not the start of a longer name ("汉兰达").
                    if not re.search(re.escape(word) + r"(?![一-鿿])", text):
                        break
                elif word not in text:
                    break
            else:
                return True
        return False

    def _candidates(self, keywords):
        """Rows containing a model word, judged by coverage rather than by word order.

        A brand word ("本田") carries no model information and cannot select rows on its own;
        a model word ("宋", "思域") can. Rows hit by the most words win, so "本田 宋" finds
        "宋Lev" (brand inline) and "东风本田 思域" finds the Civic rows.
        """
        model_words = [word for word in keywords if word not in BRANDS]
        if not model_words:
            return set()
        # A trim word ("dmi", "plus") only ranks rows a real model word already found:
        # "宋plus dmi" must not select "海豹dmi" through "dmi" alone.
        generic = GENERIC_TOKENS | TRIM_SUFFIXES
        specific = [word for word in model_words
                    if word not in generic and not (word.isdigit() and len(word) <= 2)]
        if any(not word.isdigit() for word in specific):
            # Beside a car name a bare number is a trim or displacement ("途观l 330"): it may not pull in 风光330.
            specific = [word for word in specific if not word.isdigit()]
        scores = {}
        for index, item in enumerate(self._prepared):
            hit = [word for word in model_words if self._hit(word, item)]
            if specific and not any(word in specific for word in hit):
                continue
            if hit:
                scores[index] = len(hit)
        best = max(scores.values()) if scores else 0
        return {index for index, score in scores.items() if score == best}

    def _nearest(self, indexes, years, generations):
        """The row closest to a stated year / generation the table does not have (08款 -> 09-13, 1 year off)."""
        best = None
        for index in indexes:
            item, record = self._prepared[index], self.records[index]
            record_years = next((name["years"] for name in item["names"] if name["years"]), None)
            stated = {name["generation"] for name in item["names"] if name["generation"] is not None}
            if years and record_years:
                gap, unit = max(record_years[0] - years[1], years[0] - record_years[1], 0), "年"
            elif generations and stated:
                gap, unit = min(abs(g - s) for g in generations for s in stated), "代"
            else:
                continue
            key = (gap, record["record_id"])
            if best is None or key < best[0]:
                row = {"record_id": record["record_id"], "family": record["family"], "model": record["model"],
                       "generation": min(stated) if stated else None,
                       "year_match": {"status": None, "note": None}}
                best = (key, {"row": row, "gap": gap, "unit": unit})
        return best[1] if best else None

    def search(self, query, year=None, limit=MAX_LIMIT):
        if not (isinstance(limit, int) and not isinstance(limit, bool) and 1 <= limit <= MAX_LIMIT):
            raise ValueError("invalid_limit")
        normalized = _normalize(query)
        aliased, aliases_used = self._apply_aliases(normalized)
        words, generations = _segments(aliased)
        # Brands the buyer said, alone or glued to the model ("本田n7", "本田思域"): they must not vanish.
        brands_said, model_said = [], []
        for word in words:
            # "东风日产轩逸" -> 东风, 日产 + 轩逸; "北京现代ix35" -> 北京, 现代 + ix35
            while brand := next((b for b in sorted(self.brands, key=len, reverse=True) if word.startswith(b)), None):
                brands_said.append(brand)
                word = word[len(brand):]
            if word:
                model_said.append(word)
        model_said = "".join(dict.fromkeys(model_said))
        typo = next(((said, [name]) for said, name, is_typo in aliases_used if is_typo), None)
        # A buyer word that names no row: take the table car it contains ("哈弗h6运动版"); failing that for every
        # word, a one-typo neighbour ("汉兰大" -> "汉兰达") is searched but only reported as similar, never a match.
        contained, similar, kept = [], None, []
        for word in words:
            if word not in self.brands and not self._any_hit(word) and (tokens := self._contained(word)):
                kept += tokens
                contained.append((word, tokens))
            elif (word not in self.brands and not self._any_hit(word)
                  and (base := TRIM_TAIL.fullmatch(word)) and self._any_hit(base[1])):
                # "唐dmi", "汉ev": a one-character car name with its power trim, too short to be a table word.
                kept.append(base[1])
                contained.append((word, [base[1]]))
            else:
                kept.append(word)
        words = list(dict.fromkeys(kept))
        if not any(word not in self.brands and self._any_hit(word) for word in words):
            for i, word in enumerate(words):
                if word in self.brands:
                    continue
                near = self._similar(word) or self._contained(word, loose=True)[:1]
                if near:
                    words[i], similar = near[0], (word, near)
                    break
        # A brand word carries no model information; it must not decide which car is searched
        # when the same text also names the model ("本田思域", "思域 本田").
        words.sort(key=lambda word: word in BRANDS)
        years = (year, year) if year is not None else _query_year(normalized)
        brand_only = bool(words) and all(word in self.brands for word in words)
        ask_year = False
        if brand_only:
            # "问界" / "本田": list the brand's rows so the buyer can be asked which model.
            # A brand filed under 其他 (纳智捷) is found by its rows' names.
            indexes = {item["index"] for item in self._prepared if item["directory"] in words
                       or any(word in name["text"] for word in words for name in item["names"])}
        else:
            indexes = self._candidates(words)
            # "汉" names 比亚迪汉 exactly: 比亚迪汉L is another car, not a variant to reply on. With a year, only
            # when the named car has it (26款迈腾 is 迈腾b9); without one, a dated named car asks the year first
            # ("瑞虎" may be 05-13瑞虎 or a later 瑞虎8).
            named_rows = {index for index in indexes if self._names_exactly(words, self._prepared[index])}
            if (named_rows != indexes and len({self._prepared[i]["directory"] for i in named_rows}) == 1):
                spans_of = [next((n["years"] for n in self._prepared[i]["names"] if n["years"]), None)
                            for i in named_rows]
                if years:
                    if not any(spans_of) or any(s and s[0] <= years[1] and s[1] >= years[0] for s in spans_of):
                        indexes = named_rows
                elif generations or not any(spans_of):
                    indexes = named_rows
                else:
                    ask_year = True
        rows, models, spans, dated = [], set(), set(), False
        for index in indexes:
            record, item = self.records[index], self._prepared[index]
            stated = {name["generation"] for name in item["names"] if name["generation"] is not None}
            dated = dated or any(name["years"] for name in item["names"])
            if generations:
                # A generation was asked: a row that never states one cannot answer it, and a
                # different generation is not a near miss ("十一代" must not surface "十代").
                if not stated or not (stated & generations):
                    continue
            record_years = next((name["years"] for name in item["names"] if name["years"]), None)
            year_status, year_note = None, None
            if years:
                if record_years is None:
                    # The record's name states no year: kept, flagged, never counted as a year match.
                    year_status = "unknown"
                    year_note = "该记录车型名称中没有年份，年份条件无法核对该记录"
                else:
                    low, high = record_years
                    if low <= years[1] and high >= years[0]:
                        year_status = "match"
                    else:
                        continue
            models.add(self._row_models(words, item))
            if record_years or stated:
                spans.add((record_years, frozenset(stated)))
            rows.append({
                "record_id": record["record_id"], "family": record["family"], "model": record["model"],
                "generation": min(stated) if stated else None,
                "year_match": {"status": year_status, "note": year_note},
            })
        rows.sort(key=lambda c: ((c["year_match"]["status"] != "match"), c["generation"] is None,
                                 -len(c["model"]), c["record_id"]))
        total = len(rows)
        candidates = rows[:limit]
        # The car is named when some row's model is exactly the asked word ("速腾" in "速腾 12-18", even
        # beside 速腾L), under one brand. "问界" only prefixes 问界M5/M7/M9; "m7" is 问界/风行/银河.
        named = {directory for directory, keys in models if keys & set(words)}
        year_matched = sum(1 for c in rows if c["year_match"]["status"] == "match")
        if years and dated and not year_matched:
            # The table dates this car and the stated year is in none of its ranges: no match, even
            # though undated variants (双擎E+) remain.
            rows, total, candidates = [], 0, []
        if brands_said and not brand_only and len(named) > 1:
            # "问界M7 24款" when 问界 and 风行 both have an M7: the brand the buyer said picks its own rows.
            accepted = set(brands_said) | {sub for b in brands_said for sub in PARENT_BRANDS.get(b, ())}
            by_id = {self.records[i]["record_id"]: self._prepared[i] for i in indexes}
            own = {item["directory"] for item in by_id.values() if item["directory"] in accepted} & named
            if len(own) == 1:
                rows = [c for c in rows if by_id[c["record_id"]]["directory"] in own]
                total, candidates, named = len(rows), rows[:limit], own
                year_matched = sum(1 for c in rows if c["year_match"]["status"] == "match")
                spans = {(next((n["years"] for n in by_id[c["record_id"]]["names"] if n["years"]), None),
                          frozenset(n["generation"] for n in by_id[c["record_id"]]["names"] if n["generation"] is not None))
                         for c in rows} - {(None, frozenset())}
        if brand_only or (total and len(named) != 1):
            status = "needs_model"
        elif total == 1 or year_matched == 1:
            status = "matched"
        elif total > 1 and not years and not generations and len(spans) > 1:
            # The table tells this car apart by year / generation (卡罗拉 07-13 / 14-18 / 19-25):
            # the buyer must say which year before it counts as a match.
            status = "needs_year"
        elif total:
            # Rows the table does not tell apart by year (body variants), or a year was already given.
            status = "ambiguous"
        else:
            status = "not_found"
        if ask_year and status in ("matched", "ambiguous"):
            status = "needs_year"
        seats = None
        if status == "ambiguous":
            # Rows the table tells apart by seats (宝马2系5座旅行款 / 7座旅行款): the buyer's seats pick
            # the row; without them the buyer is asked 5座还是7座, never answered "可以用".
            seat_of = lambda c: (found := SEAT_OF.search(_normalize(c["model"]))) and found[1]
            said = SEAT_OF.search(normalized)
            offered = {seat_of(c) for c in rows} - {None}
            if said and said[1] in offered:
                rows = [c for c in rows if seat_of(c) == said[1]]
                total, candidates = len(rows), rows[:limit]
                status = "matched" if total == 1 else "ambiguous"
            elif len(offered) > 1:
                # Not said, or said but not in the table ("6座" when only 5座 / 7座 exist): ask, never fit.
                status, seats = "needs_model", sorted(offered)
        if status == "not_found" and indexes and (years or generations) and words:
            # The car is in the table but not with the stated year / generation (21年的问界M7, 十二代思域):
            # a near miss, so return that car's real rows for the buyer to choose from.
            near = self.search(" ".join(words), limit=limit)
            if near["status"] != "not_found":
                status = "needs_model" if near["status"] == "needs_model" else "year_mismatch"
                candidates = near["candidates"]
        nearest = self._nearest(indexes, years, generations) if status == "year_mismatch" else None
        if nearest:
            # The closest row leads the options even when the table has more rows than the limit.
            candidates = [nearest["row"]] + [c for c in candidates if c["record_id"] != nearest["row"]["record_id"]]
            candidates = candidates[:limit]
        similar = similar or typo
        brand_conflict = None
        if brands_said and not brand_only and not similar and status != "not_found" and candidates:
            # The buyer named a brand none of these rows belong to ("本田n7": 腾势n7 / 日产n7): never answered
            # as another brand's car. One car left is a typo-like guess to confirm; several are a question.
            items = {self.records[i]["record_id"]: self._prepared[i] for i in range(len(self.records))}
            # 长城猛龙 is 哈弗猛龙: a group brand covers its sub-brands' directories.
            accepted = set(brands_said) | {sub for b in brands_said for sub in PARENT_BRANDS.get(b, ())}
            def branded(item):
                return any(b == item["directory"] or b in item["family"]
                           or any(b in name["text"] for name in item["names"]) for b in accepted)
            picked = [items[c["record_id"]] for c in candidates]
            model_words = [w for w in words if w not in self.brands]
            # "18款卡罗拉和26款名爵MG4": the brand belongs to another car the buyer also named.
            elsewhere = any(item["directory"] in accepted and self._hit(w, item)
                            for item in self._prepared for w in model_words)
            if not elsewhere and not any(branded(item) for item in picked):
                said = brands_said[0] + model_said
                directories = list(dict.fromkeys(item["directory"] for item in picked))
                # A model name of its own ("丰田思域" is 本田思域) is a brand slip to confirm; a bare code
                # ("奔驰e300" / 宝骏E300, "路虎揽胜 v6" / 中华v6) is another brand's car: this one is not in the table.
                keys = [k for k in self._row_models(model_words, picked[0])[1]
                        if k in model_words and k in self.tokens and re.search(r"[\u4e00-\u9fff]", k)]
                if len(directories) == 1 and keys:
                    name = keys[0] if directories[0] in keys[0] else directories[0] + keys[0]
                    status, nearest, similar = "similar", None, (said, [name])
                elif len(directories) == 1:
                    status, nearest, seats, brand_conflict = "not_found", None, None, said
                    rows, total, candidates = [], 0, []
                else:
                    status, nearest, seats, brand_conflict = "needs_model", None, None, said
        if similar and status != "not_found":
            # A typo neighbour is never a match: the buyer has to confirm the table's name first.
            status, nearest = "similar", None
        matched = {name["generation"] for index in indexes for name in self._prepared[index]["names"]
                   if name["generation"] is not None}
        hint = _hint(status, candidates, years, generations, nearest, similar, seats, brand_conflict)
        compact = normalized.replace(" ", "")
        reason = next((reason for words, reason in self.handoff if all(word in compact for word in words)), None)
        if reason:
            # The shop listed this car for a person: never a match or a question, whatever the table rows say.
            status, hint = "needs_human", ("店铺设定这款车需人工核实（" + reason + "），不算命中也不要追问，"
                                           "转人工并附一句过渡语；candidates 只给人工参考")
        return {"status": status, "candidates": candidates, "total_matches": total,
                "hint": hint,
                "understood": {"aliases": [(said, name) for said, name, _ in aliases_used], "contained": contained,
                               "similar": list(similar) if similar and status == "similar" else None},
                "truncated": total > limit, "generation_requested": sorted(generations) or None,
                "generations_available": sorted(matched) if generations and not total else None,
                "year_applied": years[0] if years else None,
                "year_filter": {"applied": bool(years),
                                "matched": year_matched,
                                "unknown": sum(1 for c in rows if c["year_match"]["status"] == "unknown"),
                                "reason": None if (not years or rows) else "year_outside_record"}}


# ---------------------------------------------------------------- conversation (Claw-Next)

MATCH_STATUSES = ("matched", "ambiguous")
# Statuses whose reply is one question listing the table's own options.
CHOICE_STATUSES = ("needs_year", "year_mismatch", "needs_model", "similar")
# Vehicle questions put to the buyer about one car (a match ends the count); the next one goes to a person.
MAX_VEHICLE_ASKS = 2
MAX_TURNS = 6
MAX_TEXT = 200
# The shop's fixed sentences, sent byte for byte by the server (4 spaces after 车型 are the shop's own).
FIT_REPLY = "您的车型可以用，已给您备注车型    有需要直接下单就可以了哈"
NO_SIZE_REPLY = "抱歉，这款车暂时没有对应的尺寸，用不了哦"
AFFIRM = re.compile(r"(?:是|是的|对|对的|嗯|嗯嗯|没错|就是|就是这款|是这款|对就是)[的啊呀哦哈呢]*")
# Words around a bare year / seats / generation in a short answer to a vehicle question ("18款的", "是7座").
FOLLOW_UP_FILLER = re.compile(r"我的是|我的|我家的|就是|请问|您好|你好|谢谢|好的|在吗|在么|能用吗|能装吗|可以吗|可以用吗|"
                              r"年份|年款|款式|的|是|呢|吗|款|年|版|车|哦|啊|呀|哈|嗯|对|亲|那|三厢|两厢")
# "在" is in no car name of the table, so "在呢", "在线吗", "还在不" and a lone "在" are greetings too.
GREETING = re.compile(r"在不在|在线|还在|有人|在|人呢|老板|客服|你好|您好|哈喽|嗨|hello|hi|嗯|哦|好的|谢谢|麻烦|请问")
# Order, shipping, remark and link talk ("下单了", "尽快发货", "快点", "还要备注吗", "好的发我"): never part of a car name, so a
# message made only of it does not name a car, even after an earlier car the table lacks.
SHOP_TALK = re.compile(r"已经|下单|拍下|拍好|拍了|付款|付了|买好|买了|尽快|赶紧|快点|快些|加急|发货|发出|发走|到货|"
                       r"几天|多久|快递|物流|备注|备份|记录|记下|记一下|帮我|给我|发我|发给我|发一下|发过来|链接|还要|需要|要不要|怎么|今天|明天|"
                       r"能不能|一下|没|了|已|能|不|要|下|你")
# Questions about the goods themselves ("这个透光吗", "什么材质", "怎么固定"): never part of a car name either.
PRODUCT_TALK = re.compile(r"(?:双面黑|银黑|黑银|钛银|黑色|银色)好?(?:和|跟|与)?|收纳袋|开发票|开票|提供|收到|不对|装不上|装不了|多大|大小|对折|折叠|折|透光率|透不透光|不透光|透光|遮光|透不透|不透|透明|材质|材料|面料|功能|作用|固定|打孔|安装|装上|吸盘|卡扣|钢丝|铁圈|弹性|"
                          r"厚度|多厚|厚不厚|收纳|折叠|颜色|区别|质量|隔热|防晒|效果|视频|价格|多少钱|什么|啥|怎么样|怎么|"
                          r"这个|那个|这款|有用|遮阳挡|遮阳帘|遮阳板|厚|薄|会不会|哪个好|好还是|好不好|尺寸|准不准|准吗|掉下来|会掉|"
                          r"异味|味道|防水|褪色|掉色|耐用|降温|多少度|冬天|夏天|晚上|开灯|外面|里面|看得到|看到|看见|隐私|"
                          r"发票|保修|质保|送|几片|哪些窗|哪些|包含|包括|重量|多重|多少|多久|自己|量|车帘|可不可以使用|可不可以用|能不能使用|可以使用|能使用|使用|能用吗|可以用吗|能用|可以用|用吗|会")
WINDOW = re.compile(r"前挡风|后挡风|前挡|后挡|前档|后档|前窗|后窗|中窗|侧窗|小窗|三角窗|侧三|尾挡|全车|一套|一片")
NEGATION = re.compile(r"不是|并非|不要这个|没有这个|不对")
# A buyer reporting a problem with received goods, not naming a car to look up.
COMPLAINT = re.compile(r"找遍|找不到|没找到|没有找到|少了|少一|缺了|缺一|丢了|弄丢|坏了|破了|裂了|核实|投诉|退款|退货|换货")
FIT_ASK = re.compile(r"能用|可以用|能装|可以装|适用|适合|合适|能做|可以做|有没有|有吗|有货")
NO_VEHICLE_HINT = ("最新买家消息没有说出车名：买家在问能不能用、前面也没报过车型，才请他发具体车型和年款；"
                   "下单、发货、备注等其他问题按店铺规则回答。不要说查不到车型")
ORDER_CLOSED = re.compile(r"取消|关闭|退款成功|已退款|待支付|待付款")


def _buyer_turns(messages):
    """Chronological (index, text) of the buyer's text messages."""
    if not isinstance(messages, list):
        return []
    return [(i, m["content"][:MAX_TEXT]) for i, m in enumerate(messages)
            if isinstance(m, dict) and m.get("role") == "buyer" and m.get("kind") == "text"
            and isinstance(m.get("content"), str) and m["content"].strip()]


def _follow_up(text):
    """A short answer that only adds a year, seats, a generation, a window or a yes to the car named before."""
    rest = _normalize(text)
    if len(rest) > 32:
        return False
    if AFFIRM.fullmatch(re.sub(r"[\s，。？！,.?!~～]", "", rest)):
        return True
    payload = False  # A greeting or "？" alone answers nothing about the car.
    # A bare "18" after "哪一年的？" is a year too; "后窗" after "24款启源A07" asks about that car.
    for pattern in (YEAR_RANGE, SINGLE_YEAR, GLUED_YEAR, GENERATION, SEAT_OF, DISPLACEMENT,
                    re.compile(r"(?<![a-z0-9])\d{2}(?![a-z0-9])"), WINDOW):
        payload = payload or bool(pattern.search(rest))
        rest = pattern.sub(" ", rest)
    return payload and not re.sub(r"[\s，。？！,.?!~～]", "", FOLLOW_UP_FILLER.sub("", rest))


def _window_only(text):
    return bool(WINDOW.search(_normalize(text))) and not re.sub(r"[\s，。？！,.?!~～]", "", FOLLOW_UP_FILLER.sub("", WINDOW.sub(" ", _normalize(text))))


def _named(catalog, text):
    """Whether text names a car of the table by a real car word: a brand (alone or before a code, "领克01"), or a
    word of two or more characters (not only digits) that is, contains or is one slip from a table car word. A lone
    "1" or "大" in a sentence ("这个大的一面有点宽") is not a car, even though 宝马1系 and 大7 exist."""
    words, _ = _segments(catalog._apply_aliases(_normalize(text))[0])
    for word in words:
        if any(word.startswith(brand) for brand in catalog.brands):
            return True
        if len(word) >= 2 and not word.isdigit() and (
                catalog._any_hit(word) or catalog._contained(word) or catalog._similar(word)
                or catalog._contained(word, loose=True) or TRIM_TAIL.fullmatch(word)):
            return True
    return False


def _no_car_words(text):
    """Nothing but greetings, order or goods talk, punctuation and words that are never part of a car name ("后窗",
    "在吗", "下单了", "这个透光吗")."""
    rest = FILLER.sub(" ", SHOP_TALK.sub(" ", PRODUCT_TALK.sub(" ", GREETING.sub(" ", _normalize(text)))))
    return not re.sub(r"[\s，。？！,.?!~～、…：:;；]", "", FOLLOW_UP_FILLER.sub("", rest))


def _turn(catalog, texts):
    """The lookup for the latest of texts: the latest car message plus the short answers after it, and how many
    of those answers it took in."""
    extras = []
    for text in reversed(texts[-MAX_TURNS:]):
        if _follow_up(text) and catalog.search(text)["status"] == "not_found":
            extras.insert(0, text)
            continue
        affirmed = any(AFFIRM.fullmatch(re.sub(r"[\s，。？！,.?!~～]", "", _normalize(e))) for e in extras)
        answers = [re.sub(r"(?<![a-z0-9])(\d{2})(?![a-z0-9款年])", r"\1款", _normalize(e)) for e in extras
                   if not AFFIRM.fullmatch(re.sub(r"[\s，。？！,.?!~～]", "", _normalize(e)))]
        dated = [a for a in answers if _query_year(a)]
        if dated:
            # The latest year the buyer gave replaces any earlier one ("18款" ... "22款"): only it is searched.
            for pattern in (YEAR_RANGE, SINGLE_YEAR, GLUED_YEAR):
                text = pattern.sub(" ", text)
            answers = [a for a in answers if not _query_year(a)] + dated[-1:]
        added = " ".join(answers)
        result = catalog.search((text + " " + added).strip())
        if result["status"] == "not_found" and extras and _window_only(extras[-1]):
            # "小窗的" after a complaint or an unknown car (even after a year answer) is no car: a window only
            # completes a car the table has.
            break
        if result["status"] not in ("not_found", "needs_human") and not _named(catalog, text):
            return catalog.search(""), 0  # Rows found only through a stray digit or character.
        similar = (result.get("understood") or {}).get("similar")
        if affirmed and result["status"] == "similar" and similar and len(similar[1]) == 1:
            # "是汉兰达吗？" "是的": the buyer confirmed the table's name; search it as said.
            result = catalog.search((similar[1][0] + " " + added).strip())
        return result, len(extras)
    # Only short answers ("是的", "18款") and no car named before them: nothing to carry.
    return catalog.search(texts[-1]), 0


def _seller_after(messages, index, end):
    return [m.get("content") or "" for m in messages[index + 1:end]
            if isinstance(m, dict) and m.get("role") == "agent"]


def conversation(catalog, messages, orders=()):
    """The latest buyer turn's vehicle lookup, its reply guidance and any stop the program enforces.

    forced is None, or why a person must take over: the shop listed the car for a person (needs_human), the
    buyer was already asked about this car twice (vehicle_ask_limit), keeps a year the table lacks
    (repeated_year_mismatch), or has an order and the car is still unclear (ordered_vehicle_unclear).
    """
    turns = _buyer_turns(messages)
    if not turns or turns[-1][0] != len(messages) - 1:
        return None  # The latest buyer message is not text (an image or card): no car to look up.
    texts = [text for _, text in turns][-MAX_TURNS:]
    turns = turns[-MAX_TURNS:]
    asks, last_asked = 0, None
    for n in range(len(turns) - 1):
        result, _ = _turn(catalog, texts[:n + 1])
        status = result["status"]
        replies = _seller_after(messages, turns[n][0], turns[n + 1][0])
        if status in MATCH_STATUSES:
            asks, last_asked = 0, None
        elif replies and (status in CHOICE_STATUSES
                          or (status == "not_found" and any(re.search(r"车型|车名|哪款|哪一款|哪年|年份|年款", r) for r in replies))):
            asks, last_asked = asks + 1, status
    result, followed = _turn(catalog, texts)
    if result["status"] in MATCH_STATUSES and any(NEGATION.search(_normalize(t)) for t in texts[-1 - followed:]):
        # "不是星河远航，是…" (even before a "后窗" answer): the name found may be the car the buyer denies; ask
        # instead of approving it.
        result = {**result, "status": "needs_model",
                  "hint": "买家的话里否认了某款车，表内找到的可能正是被否认的车：请买家直接说出自己的车型和年款"}
    if result["status"] == "not_found" and (
            (not followed and _no_car_words(texts[-1]))
            or (COMPLAINT.search(_normalize(texts[-1])) and not FIT_ASK.search(_normalize(texts[-1])))):
        # A complaint ("找遍了没有找到小床的") is never answered with the no-size sentence; a car the buyer asks
        # about ("请核实一下…能用吗") still is.
        result = {**result, "status": "no_vehicle", "hint": NO_VEHICLE_HINT}
    status = result["status"]
    forced = None
    if status == "needs_human":
        forced = "needs_human"
    elif status == "year_mismatch" and last_asked == "year_mismatch" and followed:
        forced = "repeated_year_mismatch"
    elif status in CHOICE_STATUSES and asks >= MAX_VEHICLE_ASKS:
        forced = "vehicle_ask_limit"
    elif status in CHOICE_STATUSES and any(
            isinstance(o, dict) and not ORDER_CLOSED.search(str(o.get("status") or "")) for o in orders or ()):
        forced = "ordered_vehicle_unclear"
    return {"status": status, "hint": result["hint"], "follow_up": bool(followed), "asks_before": asks,
            "candidates": [{"family": c["family"], "model": c["model"]} for c in result["candidates"]],
            "total_matches": result["total_matches"], "forced": forced}
