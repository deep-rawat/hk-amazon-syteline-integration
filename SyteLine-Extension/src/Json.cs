using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace HubKor.AmazonSync
{
    /// <summary>
    /// Small self-contained JSON reader/writer, so the assembly needs no JSON library reference
    /// when SyteLine builds it from source. Objects parse to Dictionary&lt;string, object&gt;,
    /// arrays to List&lt;object&gt;, numbers to decimal (double if out of range), plus string/bool/null.
    /// </summary>
    internal static class Json
    {
        public static Dictionary<string, object> Parse(string json)
        {
            var reader = new Reader(json ?? "");
            var value = reader.ReadValue();
            reader.SkipWhitespace();
            if (!reader.AtEnd)
                throw new FormatException("Unexpected text after JSON at position " + reader.Position + ".");
            var obj = value as Dictionary<string, object>;
            if (obj == null)
                throw new FormatException("Expected a JSON object.");
            return obj;
        }

        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        /// <summary>Walks a dotted path such as "product.price.unitPrice.amount". Returns null if any step is missing.</summary>
        public static object Get(Dictionary<string, object> obj, string path)
        {
            object current = obj;
            foreach (var key in path.Split('.'))
            {
                var dict = current as Dictionary<string, object>;
                if (dict == null || !dict.TryGetValue(key, out current))
                    return null;
            }
            return current;
        }

        public static string Str(Dictionary<string, object> obj, string path)
        {
            var value = Get(obj, path);
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static decimal Dec(Dictionary<string, object> obj, string path)
        {
            var s = Str(obj, path);
            decimal d;
            return decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out d) ? d : 0m;
        }

        public static List<Dictionary<string, object>> Array(Dictionary<string, object> obj, string path)
        {
            var result = new List<Dictionary<string, object>>();
            var items = Get(obj, path) as IEnumerable;
            if (items == null || items is string)
                return result;
            foreach (var item in items)
            {
                var dict = item as Dictionary<string, object>;
                if (dict != null)
                    result.Add(dict);
            }
            return result;
        }

        // ------------------------------------------------------------------ writer

        private static void Write(StringBuilder sb, object value)
        {
            if (value == null)
                sb.Append("null");
            else if (value is string)
                WriteString(sb, (string)value);
            else if (value is bool)
                sb.Append((bool)value ? "true" : "false");
            else if (value is decimal || value is double || value is float || value is int || value is long)
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
            else if (value is IDictionary<string, object>)
            {
                sb.Append('{');
                var first = true;
                foreach (var pair in (IDictionary<string, object>)value)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    Write(sb, pair.Value);
                }
                sb.Append('}');
            }
            else if (value is IEnumerable)
            {
                sb.Append('[');
                var first = true;
                foreach (var item in (IEnumerable)value)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item);
                }
                sb.Append(']');
            }
            else
                WriteString(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ------------------------------------------------------------------ reader

        private sealed class Reader
        {
            private readonly string _s;
            public int Position;

            public Reader(string s) { _s = s; }

            public bool AtEnd { get { return Position >= _s.Length; } }

            public void SkipWhitespace()
            {
                while (!AtEnd && char.IsWhiteSpace(_s[Position]))
                    Position++;
            }

            public object ReadValue()
            {
                SkipWhitespace();
                if (AtEnd)
                    throw new FormatException("Unexpected end of JSON.");
                var c = _s[Position];
                if (c == '{') return ReadObject();
                if (c == '[') return ReadArray();
                if (c == '"') return ReadString();
                if (c == 't') { Expect("true"); return true; }
                if (c == 'f') { Expect("false"); return false; }
                if (c == 'n') { Expect("null"); return null; }
                return ReadNumber();
            }

            private Dictionary<string, object> ReadObject()
            {
                var result = new Dictionary<string, object>();
                Position++; // {
                SkipWhitespace();
                if (Peek() == '}') { Position++; return result; }
                while (true)
                {
                    SkipWhitespace();
                    var key = ReadString();
                    SkipWhitespace();
                    Consume(':');
                    result[key] = ReadValue();
                    SkipWhitespace();
                    if (Peek() == ',') { Position++; continue; }
                    Consume('}');
                    return result;
                }
            }

            private List<object> ReadArray()
            {
                var result = new List<object>();
                Position++; // [
                SkipWhitespace();
                if (Peek() == ']') { Position++; return result; }
                while (true)
                {
                    result.Add(ReadValue());
                    SkipWhitespace();
                    if (Peek() == ',') { Position++; continue; }
                    Consume(']');
                    return result;
                }
            }

            private string ReadString()
            {
                Consume('"');
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd)
                        throw new FormatException("Unterminated JSON string.");
                    var c = _s[Position++];
                    if (c == '"')
                        return sb.ToString();
                    if (c != '\\')
                    {
                        sb.Append(c);
                        continue;
                    }
                    var e = _s[Position++];
                    switch (e)
                    {
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            sb.Append((char)int.Parse(_s.Substring(Position, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            Position += 4;
                            break;
                        default: sb.Append(e); break; // \" \\ \/
                    }
                }
            }

            private object ReadNumber()
            {
                var start = Position;
                while (!AtEnd && "+-0123456789.eE".IndexOf(_s[Position]) >= 0)
                    Position++;
                var text = _s.Substring(start, Position - start);
                decimal d;
                if (decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                    return d;
                double dbl;
                if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out dbl))
                    return dbl;
                throw new FormatException("Invalid JSON value at position " + start + ".");
            }

            private char Peek()
            {
                if (AtEnd)
                    throw new FormatException("Unexpected end of JSON.");
                return _s[Position];
            }

            private void Consume(char expected)
            {
                if (Peek() != expected)
                    throw new FormatException("Expected '" + expected + "' at position " + Position + ".");
                Position++;
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(_s, Position, word, 0, word.Length) != 0)
                    throw new FormatException("Invalid JSON value at position " + Position + ".");
                Position += word.Length;
            }
        }
    }
}
