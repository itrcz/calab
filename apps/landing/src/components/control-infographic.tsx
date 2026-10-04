import type { Locale } from '@/i18n';
import { ControlConnections } from './control-connections';

const copy = {
  ru: { lead: 'Данные, доступ и интеграции — под вашим управлением.', center: 'On-premise', server: 'Ваш сервер', serverText: 'Вы выбираете, где хранятся данные.', sso: 'Единый вход', ssoText: 'SSO и каталог сотрудников Active Directory.', oauth: 'Ваши приложения', oauthText: 'Вход через Calab. OAuth-клиенты внутри пространства.', roles: 'Ваши правила', rolesText: 'Роли и права: кому доступны комнаты и действия.', source: 'Доступный исходный код', transport: 'Защита при передаче' },
  en: { lead: 'Your data, access and integrations. Under your control.', center: 'On-premise', server: 'Your server', serverText: 'You choose where your data lives.', sso: 'One sign-in', ssoText: 'SSO and your Active Directory employee directory.', oauth: 'Your applications', oauthText: 'Sign in with Calab. OAuth clients in your workspace.', roles: 'Your rules', rolesText: 'Roles and permissions for rooms and actions.', source: 'Source available', transport: 'Protected in transit' },
  es: { lead: 'Datos, acceso e integraciones bajo tu control.', center: 'On-premise', server: 'Tu servidor', serverText: 'Tú decides dónde se almacenan los datos.', sso: 'Un solo acceso', ssoText: 'SSO y directorio de empleados Active Directory.', oauth: 'Tus aplicaciones', oauthText: 'Accede con Calab. Clientes OAuth en tu espacio.', roles: 'Tus reglas', rolesText: 'Roles y permisos para salas y acciones.', source: 'Código fuente disponible', transport: 'Protección en tránsito' },
  zh: { lead: '数据、访问和集成，由你掌控。', center: 'On-premise', server: '你的服务器', serverText: '由你决定数据存储位置。', sso: '统一登录', ssoText: 'SSO 与 Active Directory 员工目录。', oauth: '你的应用', oauthText: '通过 Calab 登录。在空间中创建 OAuth 客户端。', roles: '你的规则', rolesText: '通过角色和权限管理房间访问与操作。', source: '源代码可查阅', transport: '传输保护' },
};

export function ControlInfographic({ locale, title }: { locale: Locale; title: string }) {
  const t = copy[locale];
  const nodes = [
    { name: t.server, text: t.serverText, protocol: 'SELF-HOSTED', plan: 'Enterprise', className: 'control-node-server' },
    { name: t.sso, text: t.ssoText, protocol: 'OIDC + LDAPS', plan: 'Business · Enterprise', className: 'control-node-sso' },
    { name: t.oauth, text: t.oauthText, protocol: 'OAuth 2.0', plan: 'Business · Enterprise', className: 'control-node-oauth' },
    { name: t.roles, text: t.rolesText, protocol: 'RBAC', plan: '', className: 'control-node-roles' },
  ];
  return <div className="control-infographic">
    <div className="control-heading"><h2 id="control-title">{title}</h2><p>{t.lead}</p></div>
    <div className="control-map">
      <ControlConnections />
      <div className="control-hub"><img src="/calab-mark.svg" width={218} height={249} alt="Calab" /><strong>{t.center}</strong><img className="control-hub-sticker" src="/editorial/access-sticker.webp" width={420} height={420} alt="" loading="lazy" /></div>
      {nodes.map((node) => <div key={node.protocol} className={`control-node ${node.className}`}>
        <span className="control-protocol">{node.protocol}</span><h3>{node.name}</h3><p>{node.text}</p>
        {node.plan && <span className="control-plan">{node.plan}</span>}
      </div>)}
    </div>
    <div className="control-foundations"><div><span>{t.source}</span><strong>BSL 1.1</strong></div><div><span>{t.transport}</span><strong>HTTPS · WSS · DTLS-SRTP</strong></div></div>
  </div>;
}
