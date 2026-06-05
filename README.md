# Agenda de Atividades

Extensão do VS Code para registrar atividades realizadas em um projeto, acompanhar o tempo com o workspace aberto e estimar o tempo digitando.

## Como usar em desenvolvimento

1. Rode `pnpm install`.
2. Rode `pnpm run compile`.
3. Abra o projeto no VS Code e pressione `F5` para iniciar uma janela de desenvolvimento da extensão.
4. Execute o comando `Agenda de Atividades: Abrir formulário`.

Os registros ficam salvos no estado local do workspace aberto.

## Gerar arquivo de instalação

Para compilar e gerar o pacote `.vsix`:

```powershell
pnpm run build
```

O arquivo gerado pode ser instalado no VS Code com:

```powershell
code --install-extension vscode-activity-agenda-0.0.2.vsix
```

## Comandos

- `Agenda de Atividades: Abrir formulário`: abre o painel de registro.
- `Agenda de Atividades: Reiniciar contadores`: zera os contadores de tempo do workspace atual.
- `Agenda de Atividades: Exportar registros`: salva os registros em um arquivo JSON.

## Observações

O tempo digitando é calculado por eventos de alteração em documentos do VS Code. Pausas maiores que 5 segundos encerram a sessão de digitação ativa.
