#!/usr/bin/env python3
"""Small trust-boundary self-checks; no media decoding, download or installation."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('media_tools', Path(__file__).with_name('media-tools.py'))
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)
FINGERPRINT = 'FCF986EA15E6E293A5644F10B4322F04D67658D8'


class TrustBoundaryTests(unittest.TestCase):
    def test_signature_requires_validsig_and_pinned_identity(self):
        self.assertFalse(tools.signature_is_valid('[GNUPG:] GOODSIG 123 somebody', FINGERPRINT))
        self.assertFalse(tools.signature_is_valid('[GNUPG:] VALIDSIG WRONG 1 2 3 4 5 6 7 8 WRONG', FINGERPRINT))
        self.assertTrue(tools.signature_is_valid(f'[GNUPG:] VALIDSIG {FINGERPRINT} 1 2 3 4 5 6 7 8', FINGERPRINT))
        self.assertTrue(tools.signature_is_valid(f'[GNUPG:] VALIDSIG SUBKEY 1 2 3 4 5 6 7 8 {FINGERPRINT}', FINGERPRINT))

    def test_expired_or_revoked_or_multiple_signature_is_not_accepted(self):
        good = f'[GNUPG:] VALIDSIG {FINGERPRINT} 1 2 3 4 5 6 7 8'
        for invalid in ['EXPKEYSIG', 'REVKEYSIG', 'BADSIG', 'ERRSIG']:
            self.assertFalse(tools.signature_is_valid(good + '\n[GNUPG:] ' + invalid, FINGERPRINT))
        self.assertFalse(tools.signature_is_valid(good + '\n' + good, FINGERPRINT))

    def elf(self, **replace):
        values = dict(dynamic=' (NEEDED) Shared library: [libc.so.6]\n (NEEDED) Shared library: [libm.so.6]',
                      versions='Name: GLIBC_2.34\nName: GLIBC_2.39',
                      program='[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]',
                      notes='x86 ISA needed: x86-64-baseline',
                      allowlist=['libc.so.6', 'libm.so.6'], maximum='2.39')
        values.update(replace)
        return tools.elf_requirements(**values)

    def test_base_abi_accepted(self):
        self.assertEqual(self.elf()['maximumGlibcSymbol'], '2.39')

    def test_private_and_newer_dependencies_rejected(self):
        for change in [dict(dynamic=' (NEEDED) Shared library: [libavcodec.so.60]'),
                       dict(versions='Name: GLIBC_2.40'), dict(versions='Name: GLIBC_PRIVATE'),
                       dict(notes='x86 ISA needed: x86-64-v3'), dict(program='/unexpected/loader'),
                       dict(dynamic=' (NEEDED) Shared library: [libc.so.6]\n (RUNPATH) [/tmp/lib]')]:
            with self.assertRaises(ValueError):
                self.elf(**change)


if __name__ == '__main__':
    unittest.main()
