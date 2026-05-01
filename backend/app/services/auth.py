import secrets
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"

# HIPAA §164.308(a)(5)(ii)(D) password management. NIST 800-63B + complexity gate.
MIN_PASSWORD_LENGTH = 12
MIN_PASSWORD_CHAR_CLASSES = 3


class PasswordPolicyError(ValueError):
    pass


def validate_password_strength(password: str) -> None:
    if password is None or password != password.strip():
        raise PasswordPolicyError("Password must not have leading or trailing whitespace.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
        )
    classes = sum((
        any(c.islower() for c in password),
        any(c.isupper() for c in password),
        any(c.isdigit() for c in password),
        any(not c.isalnum() for c in password),
    ))
    if classes < MIN_PASSWORD_CHAR_CLASSES:
        raise PasswordPolicyError(
            f"Password must include at least {MIN_PASSWORD_CHAR_CLASSES} of: "
            "lowercase, uppercase, digit, special character."
        )


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: int, token_version: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "tv": token_version, "exp": expire, "type": "access"},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def create_refresh_token(user_id: int, token_version: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    return jwt.encode(
        {"sub": str(user_id), "tv": token_version, "exp": expire, "type": "refresh"},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None


def generate_share_token() -> str:
    return secrets.token_urlsafe(32)
