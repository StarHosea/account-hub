import unittest

from utils.totp import build_otpauth_url, generate_totp


class TotpTests(unittest.TestCase):
    # RFC 6238 测试向量：seed "12345678901234567890" 的 base32，SHA1，6 位。
    _SEED_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    def test_rfc6238_vectors(self):
        self.assertEqual(generate_totp(self._SEED_B32, at=59), "287082")
        self.assertEqual(generate_totp(self._SEED_B32, at=1111111109), "081804")
        self.assertEqual(generate_totp(self._SEED_B32, at=1111111111), "050471")

    def test_secret_normalization(self):
        # 小写、带空格、缺 padding 都应能正常解码并得到一致结果。
        spaced = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq"
        self.assertEqual(generate_totp(spaced, at=59), generate_totp(self._SEED_B32, at=59))

    def test_empty_secret_raises(self):
        with self.assertRaises(ValueError):
            generate_totp("")

    def test_otpauth_url(self):
        url = build_otpauth_url("ABCDEFGH", "user@example.com")
        self.assertTrue(url.startswith("otpauth://totp/"))
        self.assertIn("secret=ABCDEFGH", url)
        self.assertIn("issuer=OpenAI", url)
        self.assertIn("algorithm=SHA1", url)


if __name__ == "__main__":
    unittest.main()
