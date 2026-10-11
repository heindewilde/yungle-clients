"""Python client for the Yungle API. See https://docs.yungle.co."""

from ._version import VERSION
from .client import Yungle
from .errors import YungleError
from .download import download_links
from .upload import upload_file
from .webhooks import verify_webhook

__all__ = ["Yungle", "YungleError", "download_links", "upload_file", "verify_webhook"]
__version__ = VERSION
