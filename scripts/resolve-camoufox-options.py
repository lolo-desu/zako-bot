#!/root/.venvs/camoufox/bin/python
import argparse
import os
from pathlib import Path

import orjson
from camoufox.server import to_camel_case_dict
from camoufox.utils import launch_options


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue

        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        env[key.strip()] = value
    return env


def parse_window_size(raw: str | None) -> tuple[int, int] | None:
    if not raw:
        return None

    parts = raw.split(',', 1)
    if len(parts) != 2:
        raise ValueError(f'Invalid WINDOW_SIZE value: {raw}')

    width, height = (int(part.strip()) for part in parts)
    if width <= 0 or height <= 0:
        raise ValueError(f'WINDOW_SIZE must be positive: {raw}')

    return width, height


def compact_options(options: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in options.items()
        if value is not None
    }


def stringify_env(env: dict[str, object]) -> dict[str, str]:
    return {
        key: str(value)
        for key, value in env.items()
        if value is not None
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('instance')
    parser.add_argument('mode', choices=('headless', 'headed'))
    args = parser.parse_args()

    env_file = Path(f'/etc/zako-browser/{args.instance}.env')
    if not env_file.is_file():
        raise FileNotFoundError(f'Missing env file: {env_file}')

    file_env = parse_env_file(env_file)
    profile_dir = file_env['PROFILE_DIR']
    launch_env = {
        **os.environ,
        **file_env,
    }

    if args.mode == 'headed':
        display_number = file_env['DISPLAY_NUMBER']
        launch_env['DISPLAY'] = f':{display_number}'

    options = compact_options(launch_options(
        headless=args.mode == 'headless',
        window=parse_window_size(file_env.get('WINDOW_SIZE')),
        env=launch_env,
    ))

    launch_env_options = options.get('env')
    if isinstance(launch_env_options, dict):
        options['env'] = stringify_env(launch_env_options)

    payload = {
        'userDataDir': profile_dir,
        'launchOptions': to_camel_case_dict(options),
    }
    os.write(1, orjson.dumps(payload))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
