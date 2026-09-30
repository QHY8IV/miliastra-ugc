/**
 * cases.mjs —— Lua 5.3 语义用例表（由 scripts/check-lua-sim.mjs 逐条运行）
 *
 * 每条：[名字, Lua 代码, 期望]，期望是
 *   字符串                 stdout 逐字相等（print 的多个参数用制表符分隔，多次 print 用换行分隔）
 *   { err: '…' }           脚本以这条 Lua 错误结束（逐字相等，含「main:行号:」前缀）
 *   { syntax: '…' }        加载期语法错误（逐字相等）
 *   { match: /…/ }         stdout 匹配正则
 *   { timeout: true, opts }  触发步数预算（死循环保护）
 *
 * 这里的每一条期望都是 Lua 5.3 的确定行为（对照 Lua 5.3 参考手册与 lua.org 官方测试套件的已知结论），
 * 不是「模拟器现在碰巧输出什么」。凡是 5.3 与 5.4 有差异的地方，按 5.3。
 * 代码一律用 String.raw：Lua 里的反斜杠原样保留。
 */

const R = String.raw;

export const LUA_CASES = [
  // ───────────────────────── 数字：整数与浮点 ─────────────────────────
  ['整数与浮点的显示', R`print(1, 1.0, -0.0, 3/1, 2^2, 7//2, 7.0//2, 1e15, 1e100)`, '1\t1.0\t-0.0\t3.0\t4.0\t3\t3.0\t1e+15\t1e+100'],
  ['整除与取模（向负无穷取整）', R`print(7//2, -7//2, 7//-2, -7//-2, 7%3, -7%3, 7%-3, -7%-3, 7.5%2, -7.5%2, 5.5//2)`, '3\t-4\t-4\t3\t1\t2\t-2\t-1\t1.5\t0.5\t2.0'],
  ['浮点按 %.14g 显示', R`print(0.1, 0.1 + 0.2, 1/3, 100/3, 2^53, 2^63, 1e300 * 1e10, -1e300 * 1e10)`, '0.1\t0.3\t0.33333333333333\t33.333333333333\t9.007199254741e+15\t9.2233720368548e+18\tinf\t-inf'],
  ['64 位整数回绕', R`print(math.maxinteger, math.mininteger, math.maxinteger + 1 == math.mininteger, math.maxinteger * 2, math.mininteger // -1, -math.mininteger)`, '9223372036854775807\t-9223372036854775808\ttrue\t-2\t-9223372036854775808\t-9223372036854775808'],
  ['整数与浮点相等、math.type', R`print(1 == 1.0, math.type(1), math.type(1.0), math.type("1"), math.type(true))`, 'true\tinteger\tfloat\tnil\tnil'],
  ['位运算（字符串、整数值浮点会被转成整数）', R`print(3 | 4, 7 & 2, 5 ~ 1, ~0, 1 << 4, 256 >> 4, 2^4 | 0, "3" | 0)`, '7\t2\t4\t-1\t16\t16\t16\t3'],
  ['位移：越界为 0、右移是逻辑右移', R`print(1 << 62, 1 << 63, 1 << 64, -1 >> 1, 1 >> -1, 2 << -1)`, '4611686018427387904\t-9223372036854775808\t0\t9223372036854775807\t2\t1'],
  ['浮点整除 / 取模的边界', R`print(2^63 // 1, math.huge // 1, -math.huge // 1, 5 // 0.0, -5 // 0.0, 0.0 / 0.0 ~= 0.0 / 0.0, 5 % math.huge, -5 % math.huge)`, '9.2233720368548e+18\tinf\t-inf\tinf\t-inf\ttrue\t5.0\tinf'],
  ['整数除 0 / 取模 0 报错', R`print(pcall(function() return 1 // 0 end)) print(pcall(function() return 1 % 0 end)) print(1/0, -1/0)`, "false\tmain:1: attempt to perform 'n//0'\nfalse\tmain:1: attempt to perform 'n%0'\ninf\t-inf"],
  ['字符串参与算术', R`print("10" + 5, "3" * "4", "0x10" + 0, "1e1" + 1, 10 .. 20, "2" ^ 2, -"3", "10" // 3, "7" % 4)`, '15\t12\t16\t11.0\t1020\t4.0\t-3\t3\t3'],
  ['tonumber', R`print(tonumber("0x"), tonumber("1e"), tonumber(" 0x10 "), tonumber("1 2"), tonumber("10", 16), tonumber("zz", 36), tonumber("8", 8), tonumber(nil), tonumber("  "), tonumber("5."), tonumber(".5"), tonumber("0x.8"))`, 'nil\tnil\t16\tnil\t16\t1295\tnil\tnil\tnil\t5.0\t0.5\t0.5'],
  ['数字字面量', R`print(0x10, 0xA.8p0, 1e2, .5, 3., 0x.1p4, 1E+2, 9223372036854775807, 9223372036854775808, -9223372036854775808, 0xffffffffffffffff)`, '16\t10.5\t100.0\t0.5\t3.0\t1.0\t100.0\t9223372036854775807\t9.2233720368548e+18\t-9.2233720368548e+18\t-1'],
  ['运算符优先级', R`print(2 + 3 * 4 ^ 2 / 2, -2 ^ 2, not nil == true, 1 .. 2 == "12", 2 ^ 3 ^ 2, (2 ^ 3) ^ 2, 1 < 2 == true, "a" .. "b" == "ab" and "yes" or "no")`, '26.0\t-4.0\ttrue\ttrue\t512.0\t64.0\ttrue\tyes'],
  ['逻辑运算返回操作数本身', R`print(nil or "d", false and 1, 0 and "zero is true", "" and "empty is true", nil and nil, false or nil, 1 and 2 or 3)`, 'd\tfalse\tzero is true\tempty is true\tnil\tnil\t2'],
  ['比较：字符串按字节、整数浮点精确比较', R`print("10" < "9", 10 < 9, "a" < "B", "abc" < "abd", "" < "a", 1 < 1.5, 2^53 == 2^53 + 1)`, 'true\tfalse\tfalse\ttrue\ttrue\ttrue\ttrue'],

  // ───────────────────────── math ─────────────────────────
  ['math.floor / ceil / abs', R`print(math.floor(3.7), math.floor(-3.7), math.ceil(3.2), math.ceil(-3.2), math.floor(5), math.floor(2^70), math.abs(-4), math.abs(-4.5), math.abs(math.mininteger))`, '3\t-4\t4\t-3\t5\t1.1805916207174e+21\t4\t4.5\t-9223372036854775808'],
  ['math.max / min / sqrt / pi', R`print(math.max(1, 2.5), math.max(3, 2), math.min(1, 1.0), math.max(2, 2.0), math.sqrt(16), math.sqrt(2), math.pi, math.huge)`, '2.5\t3\t1\t2\t4.0\t1.4142135623731\t3.1415926535898\tinf'],
  ['math.fmod', R`print(math.fmod(7, 3), math.fmod(-7, 3), math.fmod(7, -3), math.fmod(7.5, 2), math.fmod(-7.5, 2))`, '1\t-1\t1\t1.5\t-1.5'],
  ['math.modf（浮点部分是浮点数）', R`print(math.modf(3.7)) print(math.modf(-3.7)) print(math.modf(5)) print(math.modf(math.huge))`, '3.0\t0.7\n-3.0\t-0.7\n5\t0.0\ninf\t0.0'],
  ['math.tointeger / ult', R`print(math.tointeger(3.0), math.tointeger(3.5), math.tointeger("x"), math.ult(1, -1), math.ult(-1, 1))`, '3\tnil\tnil\ttrue\tfalse'],
  ['math.random 的取值范围', R`math.randomseed(7) local ok = true for i = 1, 200 do local r = math.random(3, 5) if r < 3 or r > 5 or math.type(r) ~= "integer" then ok = false end local f = math.random() if f < 0 or f >= 1 then ok = false end end print(ok, math.random(4, 4), math.random(1))`, 'true\t4\t1'],
  ['math.random 区间为空报错', R`print(pcall(function() return math.random(2, 1) end))`, "false\tmain:1: bad argument #2 to 'random' (interval is empty)"],
  ['官方补充 math.isnan / isinf；5.1 遗留不存在', R`print(math.isnan(0/0), math.isnan(1), math.isinf(1/0), math.isinf(-1/0), math.isinf(1), math.pow, math.log10, math.atan2, math.isnaf)`, 'true\tfalse\ttrue\ttrue\tfalse\tnil\tnil\tnil\tnil'],
  ['math.log / exp / atan', R`print(math.log(8, 2), math.log(100, 10), math.log(1), math.exp(0), math.atan(1, 1) == math.pi / 4, math.sin(0), math.cos(0))`, '3.0\t2.0\t0.0\t1.0\ttrue\t0.0\t1.0'],

  // ───────────────────────── 字符串（字节串） ─────────────────────────
  ['# 是字节数、汉字 3 字节', R`print(#"abc", #"圆圈", ("圆"):byte(1, -1))`, '3\t6\t229\t156\t134'],
  ['string.sub 的下标规则', R`print(("hello"):sub(2, 4), ("hello"):sub(-3), ("hello"):sub(0), ("hello"):sub(10) == "", ("hello"):sub(2, -2), ("hello"):sub(-100, 2))`, 'ell\tllo\thello\ttrue\tell\the'],
  ['upper / lower / rep / reverse / len', R`print(("Hello"):upper(), ("Hello"):lower(), ("ab"):rep(3), ("ab"):rep(3, "-"), ("abc"):reverse(), ("abc"):len(), ("x"):rep(0) == "", ("x"):rep(-1) == "")`, 'HELLO\thello\tababab\tab-ab-ab\tcba\t3\ttrue\ttrue'],
  ['按字节切汉字 / 大小写不动汉字', R`print(("圆圈"):upper() == "圆圈", #("圆"):rep(2), ("圆圈"):sub(1, 3) == "圆", #("圆圈"):sub(1, 4))`, 'true\t6\ttrue\t4'],
  ['string.byte / char', R`print(("abc"):byte(), ("abc"):byte(2), ("abc"):byte(1, 3), ("abc"):byte(10), string.char(72, 105))`, '97\t98\t97\tnil\tHi'],
  ['转义序列', String.raw`print(#"\0abc", ("a\0b"):byte(2), "\65\066\x43\u{48}", "a\z
        b")`, '4\t0\tABCH\tab'],
  ['长字符串与长注释', 'local s = [==[\nline1\nline2]]x]==] print(#s, s:sub(1, 5)) --[[ multi\nline ]] print("after")', '14\tline1\nafter'],
  ['string.format：整数 / 宽度 / 标志 / 进制', R`print(string.format("%d|%5d|%-5d|%05d|%+d|% d|%x|%X|%#x|%o|%c", 42, 42, 42, 42, 42, 42, 255, 255, 255, 8, 65))`, '42|   42|42   |00042|+42| 42|ff|FF|0xff|10|A'],
  ['string.format：浮点 / 字符串', R`print(string.format("%5.1f|%-8.3f|%e|%g|%g|%g|%s|%10s|%-10s|%.2s|%%", 3.14159, 2.5, 12345.678, 100000, 1e20, 0.0001, "s", "right", "left", "xyz"))`, '  3.1|2.500   |1.234568e+04|100000|1e+20|0.0001|s|     right|left      |xy|%'],
  ['string.format 平局取偶（与 C 一致）', R`print(string.format("%.1f|%.0f|%.0f|%.0f|%.2f|%.2f|%5.2f", 0.25, 0.5, 1.5, 2.5, 0.125, 0.375, 2.675))`, '0.2|0|2|2|0.12|0.38| 2.67'],
  ['string.format：%d 收整数值的浮点，拒绝有小数的', R`print(string.format("%d", 3.0)) print(pcall(function() return string.format("%d", 3.5) end))`, "3\nfalse\tmain:1: bad argument #2 to 'format' (number has no integer representation)"],
  ['string.format：%s 用 tostring、数字补位', R`print(string.format("%s %s %s|%5s|%-5s|", nil, true, 1.5, 1, 2.5))`, 'nil true 1.5|    1|2.5  |'],
  ['string.format：%q', R`print(string.format("%q", 'a"b\\c\nd'))`, '"a\\"b\\\\c\\\nd"'],
  ['string.format：无效转换报错', R`print(pcall(function() return string.format("%y", 1) end))`, "false\tmain:1: invalid option '%y' to 'format'"],
  ['string.find：字面 / 模式 / 起点', R`print(("hello world"):find("wor")) print(("hello"):find("l", 1, true)) print(("hello"):find("xyz")) print(("hello"):find("")) print(("hello"):find("", 10)) print(("hello"):find("l+")) print(("abc"):find("b", -1)) print(("abc"):find("c", -1)) print(("a+b"):find("+", 1, true))`, '7\t9\n3\t3\nnil\n1\t0\nnil\n3\t4\nnil\n3\t3\n2\t2'],
  ['string.match：捕获 / 位置捕获 / 锚点', R`print(("key = value"):match("^(%w+)%s*=%s*(%w+)$")) print(("abc123def"):match("%d+")) print(("  trim  "):match("^%s*(.-)%s*$") == "trim") print(("hello"):match("()ll()")) print(("hello"):match(".-(l+)(.*)")) print(("THE (quick) fox"):find("%((%a+)%)"))`, 'key\tvalue\n123\ntrue\n3\t5\nll\to\n5\t11\tquick'],
  ['string.match：%b 与 %f', R`print(("f(a(b)c)d"):match("%b()")) print(("THE (quick) fox"):gsub("%f[%a]%a+", "W"))`, '(a(b)c)\nW (W) W\t3'],
  ['string.gsub：字符串 / 表 / 函数 / 次数', R`print(("x=1, y=2"):gsub("(%w+)=(%w+)", "%2=%1")) print(("hello world"):gsub("o", "0", 1)) print(("abc"):gsub("", "-")) print(("hello"):gsub("l", {l = "L"})) print(("hello world"):gsub("%w+", string.upper)) print(("$name is $age"):gsub("%$(%w+)", {name = "Bob", age = 42})) print(("abc"):gsub("b", "%%"))`, '1=x, 2=y\t2\nhell0 world\t1\n-a-b-c-\t4\nheLLo\t2\nHELLO WORLD\t2\nBob is 42\t2\na%c\t1'],
  ['string.gmatch', R`local out = {} for k, v in ("a=1, b=2"):gmatch("(%w+)=(%w+)") do out[#out + 1] = k .. v end print(table.concat(out, ","))`, 'a1,b2'],
  ['模式错误', R`print(pcall(function() return ("a"):find("[a") end)) print(pcall(function() return ("a"):find("%") end))`, "false\tmain:1: malformed pattern (missing ']')\nfalse\tmain:1: malformed pattern (ends with '%')"],
  ['拼接数字的显示', R`print(1 .. 2, 1.5 .. "x", 2^2 .. "", "n=" .. 10 // 3, "hp:" .. 100 / 2, -0.0 .. "", 1e15 .. "")`, '12\t1.5x\t4.0\tn=3\thp:50.0\t-0.0\t1e+15'],

  // ───────────────────────── table ─────────────────────────
  ['table.insert / remove', R`local t = {1, 2, 3} table.insert(t, 4) table.insert(t, 1, 0) print(table.concat(t, ","), #t) print(table.remove(t), table.remove(t, 1), table.concat(t, ","), #t)`, '0,1,2,3,4\t5\n4\t0\t1,2,3\t3'],
  ['table.concat 的区间与空表', R`print(table.concat({}, ","), table.concat({1, 2, 3}, ", ", 2, 3), table.concat({"a"}, ","))`, '\t2, 3\ta'],
  ['table.concat 遇到非字符串报错', R`print(pcall(function() return table.concat({1, {}, 3}) end))`, "false\tmain:1: invalid value (at index 2) in table for 'concat'"],
  ['table.unpack / pack / select', R`print(table.unpack({1, 2, 3}, 2)) print(select("#", table.unpack({}, 1, 3))) print(table.unpack({1, 2}, 1, 4)) local p = table.pack(1, nil, 3) print(p.n, #p)`, '2\t3\n3\n1\t2\tnil\tnil\n3\t3'],
  ['table.sort：数字 / 比较函数 / 字符串 / 记录', R`local t = {5, 2, 8, 1, 9, 3} table.sort(t) print(table.concat(t, ",")) table.sort(t, function(a, b) return a > b end) print(table.concat(t, ",")) local s = {"banana", "apple", "Cherry", "date"} table.sort(s) print(table.concat(s, " ")) local r = {{n = "b", v = 2}, {n = "a", v = 2}, {n = "c", v = 1}} table.sort(r, function(x, y) if x.v ~= y.v then return x.v < y.v end return x.n < y.n end) print(r[1].n, r[2].n, r[3].n)`, '1,2,3,5,8,9\n9,8,5,3,2,1\nCherry apple banana date\nc\ta\tb'],
  ['table.sort 大数组与重复元素', R`local t = {} for i = 1, 500 do t[i] = (i * 7919) % 101 end table.sort(t) local ok = true for i = 2, #t do if t[i - 1] > t[i] then ok = false end end print(ok, #t, t[1], t[500])`, 'true\t500\t0\t100'],
  ['table.move', R`local a = table.move({1, 2, 3}, 1, 3, 2) print(table.concat(a, ",")) local b = table.move({1, 2, 3}, 1, 3, 1, {}) print(#b)`, '1,1,2,3\n3'],
  ['# 与带洞的构造', R`print(#{1, 2, 3}, #{1, 2, nil}, #{nil}, #{n = 1}, #"")`, '3\t2\t0\t0\t0'],
  ['浮点键归一化为整数键', R`local t = {} t[1.0] = "a" t[2] = "b" t[2^53] = "big" print(t[1], t[2.0], #t, t[2^53])`, 'a\tb\t2\tbig'],
  ['nil / NaN 不能当键', R`print(pcall(function() local t = {} t[nil] = 1 end)) print(pcall(function() local t = {} t[0/0] = 1 end)) print(({})[nil])`, "false\tmain:1: table index is nil\nfalse\tmain:1: table index is NaN\nnil"],
  ['pairs / ipairs / next', R`local t = {10, 20, 30, x = 1} local n = 0 for k, v in pairs(t) do n = n + 1 end print(n) for i, v in ipairs({1, 2, nil, 4}) do print(i, v) end print(next({}), next({10}))`, '4\n1\t1\n2\t2\nnil\t1\t10'],
  ['遍历时置 nil 是允许的', R`local t = {a = 1, b = 2, c = 3} for k in pairs(t) do t[k] = nil end print(next(t))`, 'nil'],
  ['pairs 的顺序：数组部分先、按下标', R`local t = {} t.z = 1 t[3] = "c" t[1] = "a" t[2] = "b" local ks = {} for k in pairs(t) do ks[#ks + 1] = tostring(k) end print(table.concat(ks, ","))`, '1,2,3,z'],
  ['表的 __len 被 # 与 table 库使用', R`local t = setmetatable({}, {__len = function() return 3 end, __index = function(_, i) return i * 10 end}) print(#t, table.concat(t, ","), table.unpack(t))`, '3\t10,20,30\t10\t20\t30'],

  // ───────────────────────── 元表 ─────────────────────────
  ['__index 函数 / rawget', R`local t = setmetatable({}, {__index = function(t, k) return k * 2 end}) print(t[21], rawget(t, 21))`, '42\tnil'],
  ['__newindex：只在键不存在时触发', R`local t = setmetatable({}, {__newindex = function(t, k, v) rawset(t, k, v * 10) end}) t.a = 1 t.a = 2 print(t.a)`, '2'],
  ['类与继承', R`local Animal = {} Animal.__index = Animal
function Animal.new(name) return setmetatable({name = name}, Animal) end
function Animal:speak() return self.name .. " makes a sound" end
local Dog = setmetatable({}, {__index = Animal}) Dog.__index = Dog
function Dog.new(name) local d = Animal.new(name) return setmetatable(d, Dog) end
function Dog:speak() return self.name .. " barks" end
print(Animal.new("cat"):speak(), Dog.new("rex"):speak(), getmetatable(Dog.new("x")) == Dog)`, 'cat makes a sound\trex barks\ttrue'],
  ['算术 / 比较 / 拼接 / 长度 / 调用 / tostring 元方法', R`local V = {} V.__index = V
local function vec(x, y) return setmetatable({x = x, y = y}, V) end
V.__add = function(a, b) return vec(a.x + b.x, a.y + b.y) end
V.__eq = function(a, b) return a.x == b.x and a.y == b.y end
V.__lt = function(a, b) return a.x < b.x end
V.__le = function(a, b) return a.x <= b.x end
V.__unm = function(a) return vec(-a.x, -a.y) end
V.__len = function(a) return 2 end
V.__call = function(self, k) return self[k] end
V.__concat = function(a, b) return tostring(a) .. "|" .. tostring(b) end
V.__tostring = function(a) return "(" .. a.x .. "," .. a.y .. ")" end
local a, b = vec(1, 2), vec(3, 4)
print(tostring(a + b), a == vec(1, 2), a ~= b, a < b, a <= b, a > b, tostring(-a), #a, a("y"), a .. b, a .. "s")`, '(4,6)\ttrue\ttrue\ttrue\ttrue\tfalse\t(-1,-2)\t2\t2\t(1,2)|(3,4)\t(1,2)|s'],
  ['__pairs（5.3 支持）', R`local t = setmetatable({}, {__pairs = function(t) return function(_, k) if not k then return 1, "one" end end, t, nil end}) for k, v in pairs(t) do print(k, v) end`, '1\tone'],
  ['getmetatable 对字符串隐藏；__metatable 保护', R`print(getmetatable("x"), getmetatable({}), getmetatable(setmetatable({}, {__metatable = "locked"}))) print(pcall(function() setmetatable(setmetatable({}, {__metatable = 1}), {}) end))`, 'nil\tnil\tlocked\nfalse\tmain:1: cannot change a protected metatable'],
  ['rawequal / rawlen', R`print(rawequal("a", "a"), rawequal({}, {}), rawlen({1, 2}), rawlen("abc"), rawequal(1, 1.0))`, 'true\tfalse\t2\t3\ttrue'],
  ['__eq 只在两边都是表时才调用', R`local mt = {__eq = function() return true end} local a, b = setmetatable({}, mt), setmetatable({}, mt) print(a == b, a == 1, rawequal(a, b))`, 'true\tfalse\tfalse'],
  ['__index 链的深度', R`local base = {v = 1} local mid = setmetatable({}, {__index = base}) local top = setmetatable({}, {__index = mid}) print(top.v, top.w)`, '1\tnil'],

  // ───────────────────────── 闭包 / 可变参数 / 控制流 ─────────────────────────
  ['闭包各自有各自的上值', R`local function mk() local n = 0 return function() n = n + 1 return n end end local a, b = mk(), mk() print(a(), a(), b(), a())`, '1\t2\t1\t3'],
  ['每轮循环是新的局部变量', R`local fs = {} for i = 1, 3 do fs[i] = function() return i end end print(fs[1](), fs[2](), fs[3]()) local gs = {} local j = 0 while j < 3 do j = j + 1 local k = j gs[j] = function() return k end end print(gs[1](), gs[3]())`, '1\t2\t3\n1\t3'],
  ['可变参数', R`local function f(...) return select("#", ...), ... end print(f(1, nil, 3)) print((f(1, 2))) local t = {f(1, 2), f(3)} print(#t) print(select(-1, "a", "b", "c"), select(2, "a", "b", "c")) print(#{...})`, '3\t1\tnil\t3\n2\n3\nc\tb\tc\n0'],
  ['多重赋值：先求值后赋值', R`local a, b = 1, 2 a, b = b, a print(a, b) local i = 1 local t = {} i, t[i] = i + 1, 20 print(i, t[1], t[2]) local x, y, z = (function() return 1, 2, 3 end)() print(x, y, z) local p, q = 1 print(p, q)`, '2\t1\n2\t20\tnil\n1\t2\t3\n1\tnil'],
  ['goto continue', R`for i = 1, 5 do
  if i % 2 == 0 then goto continue end
  print(i)
  ::continue::
end`, '1\n3\n5'],
  ['goto 跳出嵌套循环 / 向回跳', R`for i = 1, 3 do for j = 1, 3 do if j == 2 then goto next_i end print(i, j) end ::next_i:: end local n = 1 ::top:: if n <= 3 then print(n) n = n + 1 goto top end`, '1\t1\n2\t1\n3\t1\n1\n2\n3'],
  ['repeat-until 的条件看得见循环体的局部变量', R`local n = 0 repeat local done = n >= 2 n = n + 1 until done print(n)`, '3'],
  ['数值 for：整数 / 浮点 / 负步长 / 步长 0', R`local t = {} for i = 1, 2, 0.5 do t[#t + 1] = i end print(table.concat(t, ",")) local u = {} for i = 10, 1, -3 do u[#u + 1] = i end print(table.concat(u, ",")) print(pcall(function() for i = 1, 10, 0 do end end)) local c = 0 for i = 1, 3.5 do c = c + 1 end print(c) for i = 3, 1 do print("never") end`, "1.0,1.5,2.0\n10,7,4,1\nfalse\tmain:1: 'for' step is zero\n3"],
  ['for 的初值 / 上限不是数字', R`print(pcall(function() for i = 1, "x" do end end)) print(pcall(function() for i = {}, 2 do end end))`, "false\tmain:1: 'for' limit must be a number\nfalse\tmain:1: 'for' initial value must be a number"],
  ['局部变量遮蔽与声明顺序', R`local x = 1 do local x = 2 end print(x) local function f() return x end local x = 5 print(f(), x)`, '1\n1\t5'],
  ['方法定义与链式调用', R`local obj = {n = 0} function obj:inc(by) self.n = self.n + (by or 1) return self end obj:inc():inc(5) print(obj.n)`, '6'],
  ['尾调用不增长栈', R`local function loop(n) if n == 0 then return "done" end return loop(n - 1) end print(loop(100000))`, 'done'],
  ['无限递归变成 stack overflow 错误', { code: R`local function f() return 1 + f() end print(pcall(f))`, match: /^false\t.*stack overflow/ }],
  ['死循环被步数预算拦下', { code: R`while true do end`, timeout: true, opts: { stepLimit: 5000 } }],
  ['pcall 拦不住步数预算', { code: R`print(pcall(function() while true do end end)) print("不该打印")`, timeout: true, opts: { stepLimit: 5000 } }],

  // ───────────────────────── 错误与 pcall ─────────────────────────
  ['error：带位置 / level 0 / 表值 / 无参', R`print(pcall(error, "msg", 0)) print(pcall(function() error("boom") end)) local ok, e = pcall(error, {code = 7}) print(ok, type(e), e.code) print(pcall(error)) print(select("#", pcall(error)))`, 'false\tmsg\nfalse\tmain:1: boom\nfalse\ttable\t7\nfalse\tnil\n2'],
  ['xpcall 的处理器收到带位置的错误', R`print(xpcall(function() error("E") end, function(m) return "handled: " .. m end)) print(xpcall(function(a, b) return a + b end, print, 1, 2))`, 'false\thandled: main:1: E\ntrue\t3'],
  ['嵌套 pcall', R`print(pcall(pcall, error, "x"))`, 'true\tfalse\tx'],
  ['error 被原生函数直接调用时没有位置前缀；被 Lua 函数调用时有', R`print(pcall(error, "msg")) print(pcall(function() error("msg") end)) print(pcall(function() return error("tail") end)) print(pcall(string.rep))`, "false\tmsg\nfalse\tmain:1: msg\nfalse\tmain:1: tail\nfalse\tbad argument #1 to 'rep' (string expected, got no value)"],
  ['assert：默认消息带位置、自定义消息带位置、返回全部参数', R`print(pcall(function() assert(false) end)) print(pcall(function() assert(nil, "custom") end)) print(assert(1, "m")) print(select("#", assert(true, nil, 3)))`, 'false\tmain:1: assertion failed!\nfalse\tmain:1: custom\n1\tm\n3'],
  ['报错带变量描述：local / upvalue / global / field / method', R`local u
local t = {}
print(pcall(function() local x = nil; return x.y end))
print(pcall(function() return u.x end))
print(pcall(function() return t.b.c end))
print(pcall(function() undefined_fn() end))
print(pcall(function() t:nope() end))
print(pcall(function() local f = 5 f() end))`, "false\tmain:3: attempt to index a nil value (local 'x')\nfalse\tmain:4: attempt to index a nil value (upvalue 'u')\nfalse\tmain:5: attempt to index a nil value (field 'b')\nfalse\tmain:6: attempt to call a nil value (global 'undefined_fn')\nfalse\tmain:7: attempt to call a nil value (method 'nope')\nfalse\tmain:8: attempt to call a number value (local 'f')"],
  ['报错：算术 / 拼接 / 长度 / 比较', R`local x local n local z
print(pcall(function() return x + 1 end))
print(pcall(function() return "a" .. n end))
print(pcall(function() return #z end))
print(pcall(function() return 1 < "x" end))
print(pcall(function() return {} < {} end))
print(pcall(function() return nil > 1 end))
print(pcall(function() return "abc" + 1 end))
print(pcall(function() return (5).x end))`, "false\tmain:2: attempt to perform arithmetic on a nil value (upvalue 'x')\nfalse\tmain:3: attempt to concatenate a nil value (upvalue 'n')\nfalse\tmain:4: attempt to get length of a nil value (upvalue 'z')\nfalse\tmain:5: attempt to compare number with string\nfalse\tmain:6: attempt to compare two table values\nfalse\tmain:7: attempt to compare number with nil\nfalse\tmain:8: attempt to perform arithmetic on a string value\nfalse\tmain:9: attempt to index a number value"],
  ['错误的行号落在出错的那一行', { code: 'local a = 1\nlocal b = 2\nlocal c = nil + 1\n', err: 'main:3: attempt to perform arithmetic on a nil value' }],
  ['pairs(nil) 的报错写法与真机一致（契约 §3d）', { code: R`for k in pairs(nil) do end`, err: "main:1: bad argument #1 to 'for iterator' (table expected, got nil)" }],

  // ───────────────────────── type / tostring / os / utf8 ─────────────────────────
  ['type 与 tostring', R`print(type(nil), type(true), type(1), type("s"), type({}), type(print), type(function() end), type(io)) print(tostring(nil), tostring(true), tostring(12), tostring(1.5), tostring("x"), tostring(print):match("^function") ~= nil, tostring({}):match("^table: 0x") ~= nil)`, 'nil\tboolean\tnumber\tstring\ttable\tfunction\tfunction\tnil\nnil\ttrue\t12\t1.5\tx\ttrue\ttrue'],
  ['被裁掉的标准库是 nil（不是报错）', R`print(io, coroutine, package, load, loadstring, dofile, collectgarbage, string.dump, string.pack, os.execute, os.getenv, debug.getinfo, unpack, table.getn, setfenv) print(type(require), type(debug.traceback), type(os.time), type(os.date), type(os.clock), type(os.difftime))`, 'nil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\nfunction\tfunction\tfunction\tfunction\tfunction\tfunction'],
  ['os.time / os.date / os.difftime', R`print(os.time{year = 2026, month = 1, day = 1, hour = 0}, os.date("!%Y-%m-%d %H:%M:%S", 1767225600), os.date("!%A %B %d", 0), os.difftime(10, 4), math.type(os.time())) print(os.date("*t", 86400).day, os.date("*t", 86400).month)`, '1767225600\t2026-01-01 00:00:00\tThursday January 01\t6.0\tinteger\n2\t1'],
  ['utf8 库', R`print(utf8.len("圆圈a"), utf8.char(22278, 97), #utf8.char(22278), utf8.codepoint("圆", 1), utf8.offset("圆圈", 2), utf8.len("\xff")) for p, c in utf8.codes("a圆") do print(p, c) end`, '3\t圆a\t3\t22278\t4\tnil\t1\n1\t97\n2\t22278'],
  ['debug.traceback 返回文本而不是打印', R`local s = debug.traceback("msg") print(type(s), s:sub(1, 3), s:find("stack traceback:", 1, true) ~= nil) print(debug.traceback(nil) == nil, debug.traceback({}) ~= nil)`, 'string\tmsg\ttrue\nfalse\ttrue'],
  ['print 用 tostring（含 __tostring）；printerr 走错误级', R`print(setmetatable({}, {__tostring = function() return "T!" end}), 1.0, nil, true) printerr("e", 1)`, 'T!\t1.0\tnil\ttrue\n[err]e\t1'],
  ['select 的边界', R`print(pcall(function() return select(0) end)) print(select("#")) print(select(3, "a", "b"))`, "false\tmain:1: bad argument #1 to 'select' (index out of range)\n0\n"],
  ['tostring / tonumber 往返', R`print(tonumber(tostring(0.1)) == 0.1, tonumber(tostring(1/3)) == 1/3, tostring(tonumber("0x7fffffffffffffff")), tostring(2^24))`, 'true\tfalse\t9223372036854775807\t16777216.0'],

  // ───────────────────────── 语法错误（加载期） ─────────────────────────
  ['语法：缺 end', { code: 'local function f()\n  if true then\n    print(1)\nend\n', syntax: "main:5: 'end' expected (to close 'function' at line 1) near <eof>" }],
  ['语法：多 end', { code: 'local x = 1\nend\n', syntax: "main:2: '<eof>' expected near 'end'" }],
  ['语法：if 缺 then', { code: 'if true\n  print(1)\nend\n', syntax: "main:2: 'then' expected near 'print'" }],
  ['语法：5.4 的 <const> 在 5.3 里不存在', { code: 'local x <const> = 1\n', syntax: "main:1: unexpected symbol near '<'" }],
  ['语法：表达式缺操作数', { code: 'print(1 +)', syntax: "main:1: unexpected symbol near ')'" }],
  ['语法：数值 for 缺逗号', { code: 'for i = 1 do end', syntax: "main:1: ',' expected near 'do'" }],
  ['语法：表没闭合', { code: 'local t = {1, 2', syntax: "main:1: '}' expected near <eof>" }],
  ['语法：全角括号', { code: 'print（1）', syntax: "main:1: unexpected symbol near '<\\239>'" }],
  ['语法：字符串被换行打断', { code: 'print("unfinished\nx', syntax: `main:1: unfinished string near '"unfinished'` }],
  ['语法：字符串撞到文件末尾', { code: 'print("unfinished', syntax: 'main:1: unfinished string near <eof>' }],
  ['语法：畸形数字', { code: 'local x = 3x', syntax: "main:1: malformed number near '3x'" }],
  ['语法：... 用在非可变参数函数里', { code: 'local function f() return ... end', syntax: "main:1: cannot use '...' outside a vararg function near '...'" }],
  ['语法：goto 找不到标签', { code: 'goto nowhere', syntax: "main:1: no visible label 'nowhere' for <goto> at line 1" }],
  ['语法：break 不在循环里', { code: 'break', syntax: 'main:1: <break> at line 1 not inside a loop' }],
  ['语法：重复标签', { code: '::a:: ::a::', syntax: "main:1: label 'a' already defined on line 1" }],
  ['语法：goto 跳进局部变量的作用域', { code: 'do goto skip local y = 1 ::skip:: print(y) end', syntax: "main:1: <goto skip> at line 1 jumps into the scope of local 'y'" }],
  ['语法：goto 到块尾的标签是合法的', { code: 'do goto skip local y = 1 ::skip:: end print("ok")', out: 'ok' }],
  ['语法：赋值给函数调用', { code: 'f() = 1', syntax: "main:1: syntax error near '='" }],
  ['语法：括号不配', { code: 'print((1 + 2)', syntax: "main:1: ')' expected near <eof>" }],

  // ───────────────────────── 程序级：小程序，期望值由 JS 独立算出或是公认结果 ─────────────────────────
  ['程序：N 皇后（6 皇后 4 解，8 皇后 92 解）', R`local function queens(n)
  local count, cols, d1, d2 = 0, {}, {}, {}
  local function place(r)
    if r > n then count = count + 1 return end
    for c = 1, n do
      if not cols[c] and not d1[r + c] and not d2[r - c + n] then
        cols[c], d1[r + c], d2[r - c + n] = true, true, true
        place(r + 1)
        cols[c], d1[r + c], d2[r - c + n] = nil, nil, nil
      end
    end
  end
  place(1)
  return count
end
print(queens(6), queens(8))`, '4\t92'],
  ['程序：埃氏筛（100 以内 25 个素数）', R`local N, sieve, primes = 100, {}, {}
for i = 2, N do sieve[i] = true end
for i = 2, math.floor(math.sqrt(N)) do if sieve[i] then for j = i * i, N, i do sieve[j] = false end end end
for i = 2, N do if sieve[i] then primes[#primes + 1] = i end end
print(#primes, primes[#primes], table.concat(primes, ",", 1, 5))`, '25\t97\t2,3,5,7,11'],
  ['程序：记忆化斐波那契（fib(80)、fib(90) 仍在 int64 内）', R`local memo = {}
local function fib(n) if n <= 2 then return 1 end if memo[n] then return memo[n] end local v = fib(n - 1) + fib(n - 2) memo[n] = v return v end
print(fib(80), fib(90))`, '23416728348467685\t2880067194370816120'],
  ['程序：21! 在 int64 里回绕', R`local f = 1 for i = 1, 21 do f = f * i end print(f) local g = 1 for i = 1, 20 do g = g * i end print(g)`, '-4249290049419214848\n2432902008176640000'],
  ['程序：64 位线性同余（Knuth MMIX），回绕结果与 BigInt 独立计算一致', R`local x = 42 for i = 1, 5 do x = x * 6364136223846793005 + 1442695040888963407 end print(x, x & 0xffff, (x >> 33) % 100)`, (() => {
    let x = 42n;
    for (let i = 0; i < 5; i++) x = BigInt.asIntN(64, x * 6364136223846793005n + 1442695040888963407n);
    const u = BigInt.asUintN(64, x);
    return `${x}\t${x & 0xffffn}\t${(u >> 33n) % 100n}`;
  })()],
  ['程序：手写 Base64（位运算 + 字节串），与 Node 的结果一致', R`local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function enc(data)
  local out = {}
  for i = 1, #data, 3 do
    local a, b, c = data:byte(i, i + 2)
    local n = (a << 16) | ((b or 0) << 8) | (c or 0)
    local c1, c2, c3, c4 = (n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63
    out[#out + 1] = chars:sub(c1 + 1, c1 + 1) .. chars:sub(c2 + 1, c2 + 1) .. (b and chars:sub(c3 + 1, c3 + 1) or "=") .. (c and chars:sub(c4 + 1, c4 + 1) or "=")
  end
  return table.concat(out)
end
print(enc("Hello, 圆圈!"), enc("a"), enc("ab"), enc("abc"))`, `${Buffer.from('Hello, 圆圈!', 'utf8').toString('base64')}\tYQ==\tYWI=\tYWJj`],
  ['程序：词频统计 + 带并列规则的排序', R`local text = "the quick brown fox jumps over the lazy dog the end"
local freq = {}
for w in text:gmatch("%a+") do freq[w] = (freq[w] or 0) + 1 end
local keys = {} for k in pairs(freq) do keys[#keys + 1] = k end
table.sort(keys, function(a, b) if freq[a] ~= freq[b] then return freq[a] > freq[b] end return a < b end)
local out = {} for i = 1, 3 do out[i] = keys[i] .. "=" .. freq[keys[i]] end print(table.concat(out, " "))`, 'the=3 brown=1 dog=1'],
  ['程序：递归序列化嵌套表（按键排序）', R`local function ser(v)
  if type(v) == "table" then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = string.format("%q:%s", tostring(k), ser(v[k])) end
    return "{" .. table.concat(parts, ",") .. "}"
  elseif type(v) == "string" then return string.format("%q", v)
  else return tostring(v) end
end
print(ser({b = 1, a = {x = true, y = 2.5}, c = "s", [3] = 9}))`, '{"3":9,"a":{"x":true,"y":2.5},"b":1,"c":"s"}'],
  ['程序：多重继承（__index 函数，Programming in Lua 的例子）', R`local function createClass(...)
  local parents = {...}
  local c = {}
  setmetatable(c, {__index = function(t, k) for _, p in ipairs(parents) do local v = p[k] if v then return v end end end})
  c.__index = c
  function c:new(o) o = o or {} setmetatable(o, c) return o end
  return c
end
local Named = {getname = function(self) return self.name end, setname = function(self, n) self.name = n end}
local Account = {balance = 0, deposit = function(self, v) self.balance = self.balance + v end}
local NA = createClass(Account, Named)
local acct = NA:new{name = "Paul"}
acct:deposit(100)
print(acct:getname(), acct.balance)`, 'Paul\t100'],
  ['程序：goto 状态机', R`local state, log = "a", {}
::loop::
log[#log + 1] = state
if state == "a" then state = "b" goto loop
elseif state == "b" then state = "c" goto loop end
print(table.concat(log, ">"))`, 'a>b>c'],
  ['程序：矩阵乘法 / 闭包迭代器 / 可变参数往返', R`local function mul(a, b) local n = #a local c = {} for i = 1, n do c[i] = {} for j = 1, n do local s = 0 for k = 1, n do s = s + a[i][k] * b[k][j] end c[i][j] = s end end return c end
local m = mul({{1, 2}, {3, 4}}, {{5, 6}, {7, 8}})
print(m[1][1], m[1][2], m[2][1], m[2][2])
local function range(n) local i = 0 return function() i = i + 1 if i <= n then return i end end end
local s = 0 for v in range(10) do s = s + v end print(s)
local function pack2(...) return {n = select("#", ...), ...} end
local p = pack2(nil, 2, nil) print(p.n, p[1], p[2], p[3], select("#", table.unpack(p, 1, p.n)))`, '19\t22\t43\t50\n55\n3\tnil\t2\tnil\t3'],
  ['程序：字符串工具（split / trim / 首字母大写）', R`local function split(s, sep)
  local out = {}
  local pat = "(.-)" .. (sep:gsub("%p", "%%%0"))
  for piece in (s .. sep):gmatch(pat) do out[#out + 1] = piece end
  return out
end
local parts = split("a,b,,c", ",")
print(#parts, table.concat(parts, "|"))
print((("  hi there  "):gsub("^%s+", ""):gsub("%s+$", "")))
print((("hello world"):gsub("(%a)(%w*)", function(a, b) return a:upper() .. b end)))`, '4\ta|b||c\nhi there\nHello World'],
  ['程序：整数与浮点混合运算的显示（平均数、整除、取模）', R`local t = {1, 2, 3, 4} local s = 0 for _, v in ipairs(t) do s = s + v end print(s / #t, s // #t, s % #t, 10 // 3 * 3 + 10 % 3) local total = 0 for i = 1, 10 do total = total + i / 2 end print(total)`, '2.5\t2\t2\t10\n27.5'],
  ['程序：Collatz / gcd / popcount', R`local n, steps = 27, 0 while n ~= 1 do if n % 2 == 0 then n = n // 2 else n = 3 * n + 1 end steps = steps + 1 end print(steps)
local function gcd(a, b) while b ~= 0 do a, b = b, a % b end return a end print(gcd(48, 18), gcd(17, 5), 48 // gcd(48, 18) * 18)
local x = 0xF0F0F0F0F0F0F0F0 local c = 0 while x ~= 0 do c = c + (x & 1) x = x >> 1 end print(c)`, '111\n6\t1\t144\n32'],
  ['程序：一万个元素排序 + 二分查找', R`local t = {} local seed = 12345 for i = 1, 10000 do seed = (seed * 1103515245 + 12345) % 2147483648 t[i] = seed % 100000 end
table.sort(t, function(a, b) return a < b end)
local ok = true for i = 2, #t do if t[i - 1] > t[i] then ok = false end end
local function bsearch(arr, x) local lo, hi = 1, #arr while lo <= hi do local mid = (lo + hi) // 2 if arr[mid] == x then return mid elseif arr[mid] < x then lo = mid + 1 else hi = mid - 1 end end return nil end
print(ok, #t, bsearch(t, t[5000]) ~= nil, bsearch(t, -1))`, 'true\t10000\ttrue\tnil'],
  ['程序：长字符串上的模式匹配（回溯不爆栈）', R`local s = ("ab"):rep(5000) .. "c" local n = 0 for _ in s:gmatch("ab") do n = n + 1 end print(n, #s:gsub("a", "xx"), s:find("c", 1, true), select(2, s:gsub("b", "b")))`, '5000\t15001\t10001\t5000'],
];
