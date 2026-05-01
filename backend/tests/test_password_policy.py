import pytest

from app.services.auth import (
    MIN_PASSWORD_LENGTH,
    MIN_PASSWORD_CHAR_CLASSES,
    PasswordPolicyError,
    validate_password_strength,
)


def test_accepts_strong_three_class_password():
    validate_password_strength("Correct-Horse-Battery")


def test_accepts_strong_four_class_password():
    validate_password_strength("Correct-Horse-9-Battery!")


def test_rejects_below_min_length():
    short = "Aa1!short"
    assert len(short) < MIN_PASSWORD_LENGTH
    with pytest.raises(PasswordPolicyError, match="at least"):
        validate_password_strength(short)


def test_rejects_single_class_at_threshold_length():
    with pytest.raises(PasswordPolicyError, match="at least"):
        validate_password_strength("alllowercase!")


def test_rejects_two_classes_only():
    pwd = "alllowercase1"  # 13 chars but only lower+digit (2 classes)
    assert len(pwd) >= MIN_PASSWORD_LENGTH
    with pytest.raises(PasswordPolicyError):
        validate_password_strength(pwd)


def test_rejects_leading_or_trailing_whitespace():
    with pytest.raises(PasswordPolicyError, match="whitespace"):
        validate_password_strength(" Correct-Horse-Battery ")
    with pytest.raises(PasswordPolicyError, match="whitespace"):
        validate_password_strength("\tCorrect-Horse-Battery")


def test_rejects_none():
    with pytest.raises(PasswordPolicyError):
        validate_password_strength(None)


def test_three_classes_is_enough():
    assert MIN_PASSWORD_CHAR_CLASSES == 3
    validate_password_strength("LowercaseUPPER1")  # lower + upper + digit
