import { Controller, Get, Body, Patch, Param, Post, UseGuards, Query, UseInterceptors, Delete, HttpCode, ClassSerializerInterceptor, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
  getSchemaPath
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';

import { UsersService } from './users.service';
import { AuthUserDto, CreateUserDto, UpdateUserDto, UpdateUserRolesDto, UpdateUserSettingsDto } from './dto';
import { User, UserDetails } from './entities';
import { RateLimitInterceptor, UploadImageInterceptor } from '../../common/interceptors';
import { Paginated } from '../../common/entities';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorMessage } from '../auth';
import { PaginateDto } from '../roles';
import { AuthUser } from '../../decorators/auth-user.decorator';
import { AuthGuardOptions } from '../../decorators/auth-guard-options.decorator';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { RateLimitOptions } from '../../decorators/rate-limit-options.decorator';
import { FileUpload } from '../../decorators/file-upload.decorator';
import { UserPermission } from '../../enums';
import {
  UPLOAD_AVATAR_MAX_SIZE,
  UPLOAD_AVATAR_TYPES,
  UPLOAD_AVATAR_MIN_WIDTH,
  UPLOAD_AVATAR_MIN_HEIGHT,
  UPLOAD_AVATAR_RATIO,
  UPLOAD_BANNER_MAX_SIZE,
  UPLOAD_BANNER_TYPES,
  UPLOAD_BANNER_MIN_WIDTH,
  UPLOAD_BANNER_MIN_HEIGHT
} from '../../config';
import { UserSettings } from './entities/user-settings.entity';

@ApiTags('Users')
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @UseInterceptors(ClassSerializerInterceptor, RateLimitInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_USERS], optional: false })
  @RateLimitOptions({ catchMode: 'success', ttl: 3600, limit: 30 })
  @ApiBearerAuth()
  @ApiOperation({ summary: `Create a user account and email an invite (permissions: ${UserPermission.MANAGE_USERS})` })
  @ApiCreatedResponse({ description: 'Return the created user', type: UserDetails })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  create(@AuthUser() authUser: AuthUserDto, @Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto, authUser);
  }

  @Get()
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_USERS] })
  @ApiBearerAuth()
  @ApiOperation({ summary: `Find all users (permissions: ${UserPermission.MANAGE_USERS})` })
  @ApiOkResponse({
    description: 'Return a list of users',
    schema: {
      allOf: [
        { $ref: getSchemaPath(Paginated) },
        {
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  _id: { type: 'string' },
                  username: { type: 'string' },
                  nickname: { type: 'string' },
                  createdAt: { type: 'string' },
                  banned: { type: 'boolean' },
                  lastActiveAt: { type: 'string' },
                  avatarUrl: { type: 'string' },
                  thumbnailAvatarUrl: { type: 'string' }
                }
              }
            }
          }
        }
      ]
    }
  })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  findAll(@Query() paginateDto: PaginateDto) {
    return this.usersService.findAll(paginateDto);
  }

  @Get(':id')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_USERS], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Get a user details (optional auth, optional permission: ${UserPermission.MANAGE_USERS})` })
  @ApiOkResponse({
    description: "Return user info.<br/>If it's your info or you have the required permissions, email, birthdate and verified will be included",
    schema: {
      allOf: [
        { $ref: getSchemaPath(UserDetails) },
        { properties: { roles: { type: 'array', items: { type: 'object', properties: { _id: { type: 'string' }, name: { type: 'string' }, color: { type: 'integer' } } } } } }
      ]
    }
  })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The resource could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  findOne(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint) {
    return this.usersService.findOne(id, authUser);
  }

  @Patch(':id')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_USERS], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Update info of a user (optional permission: ${UserPermission.MANAGE_USERS})` })
  @ApiOkResponse({ description: 'Return updated info.', type: User })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The resource could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  update(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto, authUser);
  }

  @Patch(':id/settings')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_USERS], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Update settings of a user (optional permission: ${UserPermission.MANAGE_USERS})` })
  @ApiOkResponse({ description: 'Return updated settings.', type: UserSettings })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The resource could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  updateSettings(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint, @Body() updateUserSettingsDto: UpdateUserSettingsDto) {
    return this.usersService.updateSettings(id, updateUserSettingsDto, authUser);
  }

  @Patch(':id/roles')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_ROLES], optional: false })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Update the roles of a user (permissions: ${UserPermission.MANAGE_ROLES})` })
  @ApiOkResponse({ description: 'Return the new role list', type: UpdateUserRolesDto })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The resource could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  updateRoles(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint, @Body() updateUserRolesDto: UpdateUserRolesDto) {
    return this.usersService.updateRoles(id, updateUserRolesDto, authUser);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_USERS], optional: false })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete a user and everything they own (permissions: ${UserPermission.MANAGE_USERS})` })
  @ApiNoContentResponse({ description: 'User has been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The resource could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  remove(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint) {
    return this.usersService.remove(id, authUser);
  }

  @Get(':id/avatar')
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: 'Find a user avatar' })
  @ApiOkResponse({ description: 'Return avatar urls of a user', type: User })
  @ApiNoContentResponse({ description: 'This user has no avatar' })
  @ApiNotFoundResponse({ description: 'The resource could not be found', type: ErrorMessage })
  async findOneAvatar(@Res() res: FastifyReply, @Param('id', ParseBigIntPipe) id: bigint) {
    const avatar = await this.usersService.findOneAvatar(id);
    if (!avatar) return res.status(204).send();
    return res.status(200).send(avatar);
  }

  @Patch(':id/avatar')
  @UseGuards(AuthGuard)
  @UseInterceptors(
    ClassSerializerInterceptor,
    RateLimitInterceptor,
    new UploadImageInterceptor({
      maxSize: UPLOAD_AVATAR_MAX_SIZE,
      mimeTypes: UPLOAD_AVATAR_TYPES,
      minWidth: UPLOAD_AVATAR_MIN_WIDTH,
      minHeight: UPLOAD_AVATAR_MIN_HEIGHT,
      ratio: UPLOAD_AVATAR_RATIO,
      autoResize: true
    })
  )
  @RateLimitOptions({ catchMode: 'success', ttl: 600, limit: 3 })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: 'Upload an avatar',
    description: `Limit: ${UPLOAD_AVATAR_MAX_SIZE} Bytes<br/>Min resolution: ${UPLOAD_AVATAR_MIN_WIDTH}x${UPLOAD_AVATAR_MIN_HEIGHT}<br/>
    Mime types: ${UPLOAD_AVATAR_TYPES.join(', ')}<br/>Aspect ratio: ${UPLOAD_AVATAR_RATIO.join(':')}`
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOkResponse({ description: 'Return avatar url', type: User })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updateAvatar(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint, @FileUpload() file: Storage.MultipartFile) {
    return this.usersService.updateAvatar(id, file, authUser);
  }

  @Delete(':id/avatar')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: 'Delete own avatar' })
  @ApiOkResponse({ description: 'Avatar has been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user or avatar could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  deleteAvatar(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint) {
    return this.usersService.deleteAvatar(id, authUser);
  }

  @Patch(':id/banner')
  @UseGuards(AuthGuard)
  @UseInterceptors(
    ClassSerializerInterceptor,
    RateLimitInterceptor,
    new UploadImageInterceptor({
      maxSize: UPLOAD_BANNER_MAX_SIZE,
      mimeTypes: UPLOAD_BANNER_TYPES,
      minWidth: UPLOAD_BANNER_MIN_WIDTH,
      minHeight: UPLOAD_BANNER_MIN_HEIGHT,
      autoResize: true
    })
  )
  @RateLimitOptions({ catchMode: 'success', ttl: 600, limit: 3 })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: 'Upload an banner',
    description: `Limit: ${UPLOAD_BANNER_MAX_SIZE} Bytes<br/>Min resolution: ${UPLOAD_BANNER_MIN_WIDTH}x${UPLOAD_BANNER_MIN_HEIGHT}<br/>
    Mime types: ${UPLOAD_BANNER_TYPES.join(', ')}`
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOkResponse({ description: 'Return banner url', type: UserDetails })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updateBanner(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint, @FileUpload() file: Storage.MultipartFile) {
    return this.usersService.updateBanner(id, file, authUser);
  }

  @Delete(':id/banner')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: 'Delete own banner' })
  @ApiOkResponse({ description: 'Banner has been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user or banner could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  deleteBanner(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint) {
    return this.usersService.deleteBanner(id, authUser);
  }
}
