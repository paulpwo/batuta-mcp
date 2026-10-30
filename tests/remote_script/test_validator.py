import unittest

from remote_script.BatutaMCP import validator as v
from remote_script.BatutaMCP.errors import BatutaError


class ValidatorTests(unittest.TestCase):
    def assertInvalid(self, schema, value):
        with self.assertRaises(BatutaError) as ctx:
            v.validate(schema, value)
        self.assertEqual(ctx.exception.code, "invalid_args")
        return ctx.exception

    def test_integer_rejects_bool_float_and_string(self):
        schema = v.integer()
        self.assertEqual(v.validate(schema, 3), 3)
        for bad in (True, False, 3.0, "3", None):
            self.assertInvalid(schema, bad)

    def test_integer_range(self):
        schema = v.integer(min=1, max=5)
        self.assertEqual(v.validate(schema, 5), 5)
        self.assertInvalid(schema, 0)
        self.assertInvalid(schema, 6)

    def test_number_rejects_bool_and_non_finite(self):
        schema = v.number(min=0.0, max=1.0)
        self.assertEqual(v.validate(schema, 1), 1)
        self.assertEqual(v.validate(schema, 0.5), 0.5)
        for bad in (True, float("nan"), float("inf"), -0.1, 1.1, "0.5"):
            self.assertInvalid(schema, bad)

    def test_number_exclusive_minimum(self):
        schema = v.number(min=0, exclusive_min=True)
        self.assertInvalid(schema, 0)
        self.assertEqual(v.validate(schema, 0.001), 0.001)

    def test_boolean_is_strict(self):
        schema = v.boolean()
        self.assertIs(v.validate(schema, True), True)
        for bad in (1, 0, "true", None):
            self.assertInvalid(schema, bad)

    def test_string_limits_and_control_characters(self):
        schema = v.string(max_chars=4)
        self.assertEqual(v.validate(schema, "abcd"), "abcd")
        self.assertInvalid(schema, "abcde")
        for bad in ("a\x00b", "a\nb", "a\x7fb", "a\x85b", "a‮b", "a⁦b"):
            self.assertInvalid(v.string(), bad)

    def test_string_byte_cap_and_pattern(self):
        self.assertInvalid(v.string(max_bytes=3), "éé")
        pattern = v.string(pattern=r"^[A-Za-z ]{1,8}$")
        self.assertEqual(v.validate(pattern, "Drum Rack"[:8]), "Drum Rac")
        self.assertInvalid(pattern, "Bad;name")

    def test_enum(self):
        schema = v.enum("start", "stop")
        self.assertEqual(v.validate(schema, "stop"), "stop")
        self.assertInvalid(schema, "pause")
        self.assertInvalid(v.enum(1, 2), True)

    def test_array_bounds_and_item_paths(self):
        schema = v.array(v.integer(min=0), min_items=1, max_items=3)
        self.assertEqual(v.validate(schema, [1, 2]), [1, 2])
        self.assertInvalid(schema, [])
        self.assertInvalid(schema, [1, 2, 3, 4])
        error = self.assertInvalid(schema, [1, -1])
        self.assertIn("[1]", error.details["path"])

    def test_object_strictness_required_and_defaults(self):
        schema = v.obj({"a": v.integer(), "b": v.with_default(v.boolean(), True)},
                       required=["a"])
        self.assertEqual(v.validate(schema, {"a": 1}), {"a": 1, "b": True})
        self.assertEqual(v.validate(schema, {"a": 1, "b": False}), {"a": 1, "b": False})
        error = self.assertInvalid(schema, {"b": True})
        self.assertEqual(error.details["reason"], "missing")
        error = self.assertInvalid(schema, {"a": 1, "zzz": 2})
        self.assertEqual(error.details["reason"], "unknown_key")
        self.assertInvalid(schema, [])

    def test_defaults_are_not_shared(self):
        schema = v.obj({"x": v.with_default(v.array(v.integer()), [])})
        first = v.validate(schema, {})
        first["x"].append(1)
        self.assertEqual(v.validate(schema, {})["x"], [])

    def test_at_least_one_and_exclusive(self):
        schema = v.obj({"a": v.integer(), "b": v.integer()},
                       at_least_one=True, exclusive=[("a", "b")])
        self.assertEqual(v.validate(schema, {"a": 1}), {"a": 1})
        self.assertInvalid(schema, {})
        self.assertInvalid(schema, {"a": 1, "b": 2})

    def test_nullable(self):
        schema = v.nullable(v.integer())
        self.assertIsNone(v.validate(schema, None))
        self.assertEqual(v.validate(schema, 4), 4)

    def test_one_of(self):
        schema = v.one_of(v.integer(), v.obj({"name": v.string()}, required=["name"]))
        self.assertEqual(v.validate(schema, 2), 2)
        self.assertEqual(v.validate(schema, {"name": "x"}), {"name": "x"})
        self.assertInvalid(schema, True)

    def test_track_ref(self):
        ref = v.TRACK_REF
        self.assertEqual(v.validate(ref, {"kind": "track", "index": 2})["index"], 2)
        self.assertEqual(v.validate(ref, {"kind": "master"})["kind"], "master")
        self.assertInvalid(ref, {"kind": "track"})
        self.assertInvalid(ref, {"kind": "track", "index": True})
        self.assertInvalid(ref, {"kind": "bogus", "index": 0})

    def test_paging_defaults(self):
        self.assertEqual(v.validate(v.obj(v.PAGING_PROPS), {}), {"limit": 100, "offset": 0})
        self.assertInvalid(v.obj(v.PAGING_PROPS), {"limit": 501})

    def test_free_dict_for_batch_op_args(self):
        self.assertEqual(v.validate(v.free_object(), {"x": 1}), {"x": 1})
        self.assertInvalid(v.free_object(), [])


if __name__ == "__main__":
    unittest.main()
