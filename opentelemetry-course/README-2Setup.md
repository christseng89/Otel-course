# Setup OpenTelemetry

## Prerequsite

```bash
node -v
# v22.23.2
npm --version
# 10.9.8
python --version
# Python 3.12.10
```

```powershell
wsl --install -d Ubuntu-24.04
explorer.exe .
code .
```

## Python Virtual Environment

```bash
pyenv global 3.12.10
pyenv local 3.12.10

python -m venv .venv
source .venv/Scripts/activate

python --version
which python
echo $VIRTUAL_ENV
```