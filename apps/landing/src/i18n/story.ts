import type { Locale } from './locales';

const stories = {
  "ru": {
    "previewTitle": "Вот где всё происходит",
    "kicker": "Пространство для вашей команды",
    "title": [
      "Вся команда.",
      "Рядом."
    ],
    "lead": "Разговоры, встречи и задачи — в одном пространстве. В облаке или на вашем сервере.",
    "tabs": [
      "Обсуждайте",
      "Общайтесь",
      "Делайте"
    ],
    "first": "Разговор начинается\nс одного клика.",
    "firstText": "Зайдите в голосовую комнату, покажите экран и решите вопрос вместе. Без новой ссылки на каждый разговор.",
    "second": "Обсудили.\nТеперь в дело.",
    "secondText": "Превратите сообщение в задачу. Обсуждение остаётся в чате, следующий шаг — на доске.",
    "control": "Ваша команда.\nВаши правила.",
    "controlText": "Разверните Calab на своём сервере. Управляйте доступом через роли, корпоративный SSO и Active Directory.",
    "access": "SSO · Active Directory · OAuth 2.0",
    "plan": "Business и Enterprise",
    "more": "Все возможности",
    "compare": "Сравнить все возможности тарифов",
    "detail": "От голоса до интеграций",
    "scene": "Интерфейс Calab",
    "step": "Сообщение → задача → результат"
  },
  "en": {
    "previewTitle": "Where it all happens",
    "kicker": "A space for your team",
    "title": [
      "Your team.",
      "Together."
    ],
    "lead": "Conversations, meetings and tasks in one place. In the cloud or on your own server.",
    "tabs": [
      "Discuss",
      "Connect",
      "Build"
    ],
    "first": "A conversation.\nOne click away.",
    "firstText": "Join a voice room, share your screen and work it out together. No new meeting link for every conversation.",
    "second": "Talk it through.\nMake it happen.",
    "secondText": "Turn a message into a task. Keep the discussion in the chat and the next step on the board.",
    "control": "Your team.\nYour rules.",
    "controlText": "Run Calab on your own server. Manage access with roles, corporate SSO and Active Directory.",
    "access": "SSO · Active Directory · OAuth 2.0",
    "plan": "Business and Enterprise",
    "more": "Explore all features",
    "compare": "Compare all plan features",
    "detail": "From voice to integrations",
    "scene": "Calab interface",
    "step": "Message → task → result"
  },
  "es": {
    "previewTitle": "Aquí es donde todo sucede",
    "kicker": "Un espacio para tu equipo",
    "title": [
      "Tu equipo.",
      "Cerca."
    ],
    "lead": "Conversaciones, reuniones y tareas en un solo lugar. En la nube o en tu servidor.",
    "tabs": [
      "Hablar",
      "Conectar",
      "Crear"
    ],
    "first": "Una conversación.\nA un clic.",
    "firstText": "Entra en una sala de voz, comparte pantalla y resolved juntos. Sin crear un enlace para cada conversación.",
    "second": "Lo hablamos.\nLo hacemos.",
    "secondText": "Convierte un mensaje en una tarea. La conversación queda en el chat y el siguiente paso, en el tablero.",
    "control": "Tu equipo.\nTus reglas.",
    "controlText": "Aloja Calab en tu servidor. Gestiona el acceso con roles, SSO corporativo y Active Directory.",
    "access": "SSO · Active Directory · OAuth 2.0",
    "plan": "Business y Enterprise",
    "more": "Todas las funciones",
    "compare": "Comparar todas las funciones",
    "detail": "De la voz a las integraciones",
    "scene": "Interfaz de Calab",
    "step": "Mensaje → tarea → resultado"
  },
  "zh": {
    "previewTitle": "一切协作，在这里发生",
    "kicker": "属于团队的空间",
    "title": [
      "整个团队。",
      "近在身边。"
    ],
    "lead": "交流、会议和任务，尽在同一空间。使用云端或部署在自己的服务器上。",
    "tabs": [
      "讨论",
      "交流",
      "协作"
    ],
    "first": "一次点击，\n开始交谈。",
    "firstText": "加入语音房间，共享屏幕，一起解决问题。无需为每次交流创建会议链接。",
    "second": "讨论之后，\n立即行动。",
    "secondText": "将消息转为任务。讨论保留在聊天中，下一步呈现在看板上。",
    "control": "你的团队。\n你的规则。",
    "controlText": "在自己的服务器部署 Calab。通过角色、企业 SSO 和 Active Directory 管理访问。",
    "access": "SSO · Active Directory · OAuth 2.0",
    "plan": "Business 和 Enterprise",
    "more": "查看全部功能",
    "compare": "比较所有方案功能",
    "detail": "从语音到集成",
    "scene": "Calab 界面",
    "step": "消息 → 任务 → 成果"
  }
};
export const getStory = (locale: Locale) => stories[locale];
