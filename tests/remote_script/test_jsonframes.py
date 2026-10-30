import json
import struct
import unittest

from remote_script.BatutaMCP import jsonframes
from remote_script.BatutaMCP.jsonframes import FrameDecoder, FrameError, encode_frame, parse_object


def frame(body):
    return struct.pack(">I", len(body)) + body


class DecoderTests(unittest.TestCase):
    def test_roundtrip(self):
        decoder = FrameDecoder()
        bodies = decoder.feed(encode_frame({"a": 1}))
        self.assertEqual([json.loads(b) for b in bodies], [{"a": 1}])

    def test_split_and_coalesced_input(self):
        data = encode_frame({"n": 1}) + encode_frame({"n": 2})
        decoder = FrameDecoder()
        out = []
        for index in range(len(data)):
            out.extend(decoder.feed(data[index:index + 1]))
        self.assertEqual([json.loads(b)["n"] for b in out], [1, 2])
        self.assertFalse(decoder.has_partial)

    def test_partial_flag(self):
        decoder = FrameDecoder()
        decoder.feed(struct.pack(">I", 10) + b"abc")
        self.assertTrue(decoder.has_partial)

    def test_zero_length_is_bad_request_without_reading_body(self):
        with self.assertRaises(FrameError) as ctx:
            FrameDecoder().feed(struct.pack(">I", 0))
        self.assertEqual(ctx.exception.code, "bad_request")

    def test_oversize_is_too_large_from_header_alone(self):
        with self.assertRaises(FrameError) as ctx:
            FrameDecoder().feed(struct.pack(">I", 1_048_577))
        self.assertEqual(ctx.exception.code, "too_large")

    def test_max_length_header_is_accepted(self):
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(struct.pack(">I", 1_048_576)), [])
        self.assertTrue(decoder.has_partial)

    def test_huge_garbage_length(self):
        with self.assertRaises(FrameError) as ctx:
            FrameDecoder().feed(b"\xff\xff\xff\xff")
        self.assertEqual(ctx.exception.code, "too_large")

    def test_encode_rejects_oversize_and_nan(self):
        with self.assertRaises(FrameError) as ctx:
            encode_frame({"s": "x" * 1_048_576})
        self.assertEqual(ctx.exception.code, "too_large")
        with self.assertRaises(ValueError):
            encode_frame({"v": float("nan")})


class ParseTests(unittest.TestCase):
    def assertBad(self, body):
        with self.assertRaises(FrameError) as ctx:
            parse_object(body)
        self.assertEqual(ctx.exception.code, "bad_request")

    def test_valid_object(self):
        self.assertEqual(parse_object(b'{"a": [1, 2.5, true, null, "x"]}'),
                         {"a": [1, 2.5, True, None, "x"]})

    def test_bools_stay_bools(self):
        value = parse_object(b'{"t": true, "f": false, "i": 1}')
        self.assertIs(value["t"], True)
        self.assertIs(value["f"], False)
        self.assertIs(type(value["i"]), int)

    def test_invalid_utf8(self):
        self.assertBad(b'{"a": "\xff\xfe"}')

    def test_bom_is_rejected(self):
        self.assertBad(b'\xef\xbb\xbf{"a": 1}')

    def test_not_an_object(self):
        self.assertBad(b"[1, 2]")
        self.assertBad(b"42")
        self.assertBad(b'"s"')

    def test_not_json(self):
        self.assertBad(b"{nope")
        self.assertBad(b"")

    def test_nan_and_infinity_literals(self):
        self.assertBad(b'{"a": NaN}')
        self.assertBad(b'{"a": Infinity}')
        self.assertBad(b'{"a": -Infinity}')

    def test_overflowing_float_becomes_infinity_and_is_rejected(self):
        self.assertBad(b'{"a": 1e400}')
        self.assertBad(b'{"a": -1e400}')

    def test_duplicate_keys(self):
        self.assertBad(b'{"a": 1, "a": 2}')

    def test_integer_beyond_2_pow_53(self):
        self.assertBad(b'{"a": 9007199254740993}')
        self.assertEqual(parse_object(b'{"a": 9007199254740992}')["a"], 2 ** 53)
        self.assertBad(b'{"a": -9007199254740993}')

    def test_absurdly_long_integer_is_rejected_not_slow(self):
        self.assertBad(b'{"a": ' + b"9" * 5000 + b"}")

    def test_depth_limit(self):
        ok = b'{"a":' * 32 + b"1" + b"}" * 32  # exactly 32 levels
        self.assertEqual(type(parse_object(ok)), dict)
        deep = b'{"a":' * 33 + b"1" + b"}" * 33  # 33 levels
        self.assertBad(deep)

    def test_very_deep_input_does_not_recurse(self):
        self.assertBad(b"[" * 200000)
        self.assertBad(b'{"a":' + b"[" * 100000 + b"]" * 100000 + b"}")

    def test_brackets_inside_strings_do_not_count(self):
        body = json.dumps({"a": "[" * 500 + "{" * 500 + '\\"[[['}).encode()
        self.assertEqual(type(parse_object(body)), dict)

    def test_escaped_quote_does_not_end_string_for_depth_scan(self):
        body = b'{"a": "\\"' + b"[" * 100 + b'"}'
        self.assertEqual(type(parse_object(body)), dict)

    def test_array_and_key_caps(self):
        self.assertEqual(len(parse_object(json.dumps({"a": [0] * 10000}).encode())["a"]), 10000)
        self.assertBad(json.dumps({"a": [0] * 10001}).encode())
        keys = {("k%d" % i): 1 for i in range(256)}
        self.assertEqual(len(parse_object(json.dumps(keys).encode())), 256)
        keys["k256"] = 1
        self.assertBad(json.dumps(keys).encode())

    def test_string_cap_is_in_bytes(self):
        self.assertEqual(len(parse_object(json.dumps({"a": "x" * 4096}).encode())["a"]), 4096)
        self.assertBad(json.dumps({"a": "x" * 4097}).encode())
        self.assertBad(json.dumps({"a": "é" * 2049}, ensure_ascii=False).encode())
        self.assertBad(json.dumps({"k" * 4097: 1}).encode())

    def test_nested_array_cap(self):
        self.assertBad(json.dumps({"a": [[0] * 10001]}).encode())


if __name__ == "__main__":
    unittest.main()
